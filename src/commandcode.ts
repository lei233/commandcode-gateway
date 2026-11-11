/**
 * 请求级 CommandCodeAdapter 封装。
 *
 * 每次调用新建 adapter：`protocol: 'cli'` 强制 CLI 传输、`resolveApiKey`
 * 闭包持有当前请求凭据（透传方案，无轮换）、`noRedirectFetch` 拒绝重定向。
 * 流式/非流式空闲超时由调用方按请求 `stream` 选用后经 `streamIdleTimeoutMs`
 * 注入；`requestTimeoutMs` 固定 300s 首字节超时。
 * 生成与模型发现统一经过 adapter；重试由 adapter 管理，网关不叠加。
 * 错误映射为结构化 GatewayError：401/403/429 保留上游状态码，
 * UNSUPPORTED_CONTENT 映射 400，超时 504，协议失败 502；消息有界不含凭据。
 */

import {
  CommandCodeAdapter,
  LlmError,
  PROVIDER,
} from './runtime.ts'

import type {
  CommandCodeAdapterDeps,
  CommandCodeConnectionOptions,
  GenerateOptions,
  LlmModelInfo,
  ResolveAttachments,
  StreamChunk,
} from './runtime.ts'

export interface AdapterCall {
  apiKey: string
  signal: AbortSignal
}

/** 网关对外的结构化错误；server 层据此渲染 JSON 错误体与状态码。 */
export interface GatewayError {
  status: number
  code: string
  message: string
  retryAfterSeconds?: number
}

/** adapter 运行配置；只含固定事实，不含凭据。 */
export interface AdapterConfig {
  apiBase: string
  workingDir: string
  modelsCachePath: string
  /** 流式/非流式按请求选用的上游读空闲超时。 */
  streamIdleTimeoutMs?: number
  /** 测试注入的 transport；生产为全局 fetch。 */
  fetchImpl?: typeof fetch
}

function connectionOptions(config: AdapterConfig, streamIdleTimeoutMs: number): CommandCodeConnectionOptions {
  return {
    apiBase: config.apiBase,
    workingDir: config.workingDir,
    modelsCachePath: config.modelsCachePath,
    // 固定 300s 首字节超时；空闲超时是请求级语义。
    requestTimeoutMs: 300_000,
    streamIdleTimeoutMs,
    maxOutputTokens: 0,
    protocol: 'cli',
  }
}

/**
 * fetch 包装：固定上游规则——重定向即协议失败，绝不跟随。
 * 全局 fetch 与注入 transport 同语义，测试与生产一致。
 */
function noRedirectFetch(underlying: typeof fetch): typeof fetch {
  return (input, init) => underlying(input, { ...init, redirect: 'error' })
}

/**
 * 经请求级 adapter 流式生成。迭代器由调用方恰好消费一次
 * （JSON 聚合或 SSE 编码）。带图请求传入 `resolveAttachments`
 * 返回请求内存附件 store。
 */
export function streamCommandCode(
  config: AdapterConfig,
  call: AdapterCall,
  options: Omit<GenerateOptions, 'signal' | 'provider'> & { provider?: string },
  resolveAttachments?: ResolveAttachments,
): AsyncIterable<StreamChunk> {
  const idleMs = config.streamIdleTimeoutMs ?? 300_000
  const connection = connectionOptions(config, idleMs)
  const deps: CommandCodeAdapterDeps<CommandCodeConnectionOptions> = {
    options: () => connection,
    resolveApiKey: async () => call.apiKey,
    fetchImpl: noRedirectFetch(config.fetchImpl ?? fetch),
    ...(resolveAttachments !== undefined ? { resolveAttachments } : {}),
  }
  const adapter = new CommandCodeAdapter(deps)
  return adapter.stream({ ...options, provider: options.provider ?? PROVIDER, signal: call.signal })
}

/**
 * 经请求级 adapter 拉取模型目录（原始 LlmModelInfo，由 models.ts 决定
 * 缓存或兜底）。失败直接上抛，由调用方选择兜底路径。
 */
export async function listCommandCodeModels(
  config: AdapterConfig,
  call: AdapterCall,
): Promise<readonly LlmModelInfo[]> {
  const connection = connectionOptions(config, config.streamIdleTimeoutMs ?? 300_000)
  const deps: CommandCodeAdapterDeps<CommandCodeConnectionOptions> = {
    options: () => connection,
    resolveApiKey: async () => call.apiKey,
    fetchImpl: noRedirectFetch(config.fetchImpl ?? fetch),
  }
  const adapter = new CommandCodeAdapter(deps)
  return adapter.listModels(PROVIDER)
}

/**
 * 映射 adapter/LlmError 失败到网关 HTTP 表面。只暴露稳定代码与有界固定
 * 消息，provider 原文与凭据不透出。
 */
export function mapAdapterError(error: unknown): GatewayError {
  if (isSymbolicAbort(error)) {
    const cause = error as 'deadline' | 'client' | 'shutdown'
    if (cause === 'deadline') {
      return { status: 504, code: 'upstream_timeout', message: 'commandcode request deadline exceeded' }
    }
    if (cause === 'shutdown') {
      return { status: 503, code: 'server_shutdown', message: 'gateway shutting down' }
    }
    return { status: 499, code: 'client_closed_request', message: 'request canceled' }
  }
  if (error instanceof LlmError) {
    const failure = error.failure
    const status = failure.status
    let httpStatus = 502
    // 401/403/404/429 直接透传：凭据、模型不存在与限流对客户端语义稳定，
    // 404 透传可让客户端停止重试必然失败的请求。
    if (status === 401 || status === 403 || status === 404 || status === 429) httpStatus = status
    else if (error.code === 'UNSUPPORTED_CONTENT') httpStatus = 400
    else if (error.code === 'TIMEOUT' || /timed? ?out/i.test(failure.code)) httpStatus = 504
    const retryAfterSeconds = failure.providerRetryAfterMs !== undefined && failure.providerRetryAfterMs > 0
      ? Math.ceil(failure.providerRetryAfterMs / 1000)
      : undefined
    return {
      status: httpStatus,
      code: boundedCode(failure.code),
      message: boundedMessageFor(httpStatus),
      retryAfterSeconds,
    }
  }
  if (isAbortTimeout(error)) {
    return { status: 504, code: 'upstream_timeout', message: 'commandcode upstream timed out' }
  }
  if (isAbortError(error)) {
    // 无符号原因的裸 AbortError：调用方已离开。
    return { status: 499, code: 'client_closed_request', message: 'request canceled' }
  }
  return { status: 502, code: 'upstream_unavailable', message: 'commandcode upstream request failed' }
}

/**
 * adapter 原样 rethrow abort reason（signal.throwIfAborted），server 设置的
 * 符号化原因以裸字符串到达此处。
 */
function isSymbolicAbort(error: unknown): error is 'deadline' | 'client' | 'shutdown' {
  return error === 'deadline' || error === 'client' || error === 'shutdown'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isAbortTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

const KNOWN_CODES = new Set([
  'AUTH', 'RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
  'NO_ADAPTER', 'TIMEOUT', 'UNAVAILABLE', 'PROTOCOL', 'REQUEST_TOO_LARGE',
  'UNSUPPORTED_CONTENT',
])

function boundedCode(code: string): string {
  const trimmed = code.trim()
  if (trimmed && KNOWN_CODES.has(trimmed)) return trimmed.toLowerCase().replaceAll('_', '-')
  return 'upstream_error'
}

function boundedMessageFor(status: number): string {
  switch (status) {
    case 400: return 'the request content is not supported by the selected model'
    case 401: return 'commandcode rejected the credential'
    case 403: return 'commandcode refused the request'
    case 404: return 'commandcode reported the model or endpoint as not found'
    case 429: return 'commandcode rate limited the request'
    case 504: return 'commandcode upstream timed out'
    default: return 'commandcode upstream request failed'
  }
}
