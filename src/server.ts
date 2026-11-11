/**
 * 原生 node:http TCP 服务器：路由、请求准入、请求作用域、取消传播、
 * SSE 生命周期（延迟开流、事件触发心跳、背压）与优雅关停。
 *
 * 管线（POST /v1/chat/completions）：
 * 鉴权 → 在途限制 → 读体（413）→ JSON → chat 转换 → 图片准入 →
 * 请求作用域 AbortController（客户端断开即取消）→ adapter 流 →
 * JSON 聚合 或 SSE 延迟开流。
 *
 * SSE：首个可输出帧到达才提交 200；此前错误仍返回 JSON 错误体。
 * 开流后错误发 `data: {"error":...}` 错误帧并以正常响应关闭（保证帧送达），
 * 失败路径不追加 [DONE]。已开流且上游有数据但无可见输出时写 `: keepalive`。
 * 背压等待 drain，与连接关闭/错误/取消竞速；可选 drain 超时默认关闭。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { normalizeCredentials } from './auth.ts'
import { mapAdapterError, streamCommandCode } from './commandcode.ts'
import type { AdapterConfig, GatewayError } from './commandcode.ts'
import type { GatewayConfig } from './config.ts'
import { admitImageDataUrls } from './images.ts'
import { ImageRequestError } from './images.ts'
import { FALLBACK_MODEL_IDS } from './models.ts'
import { chatToGenerateOptions, isChatRequestError } from './protocol/chat.ts'
import { aggregateToChatJson } from './protocol/complete.ts'
import { StreamFailure } from './protocol/output.ts'
import { ChatSseEncoder } from './protocol/sse.ts'

import type { AttachmentStore } from './runtime.ts'

export interface GatewayServer {
  server: Server
  /** 实际监听地址（启动后可用）。 */
  address: { host: string; port: number }
  /** 优雅关停：停止接受连接，等待在途请求清空或超时强制取消。 */
  close: (graceMs: number) => Promise<'clean' | 'forced'>
}

interface RequestScope {
  controller: AbortController
}

export interface ServerOptions {
  config: GatewayConfig
  /** adapter 固定事实；测试注入 fetchImpl。 */
  adapter: AdapterConfig
  /** 模型目录查询（M6 注入；缺省固定列表）。 */
  listModels?: (apiKey: string | undefined, signal: AbortSignal) => Promise<{ id: string }[]>
}

/** 在途生成请求登记；健康检查不计入。 */
const JSON_CONTENT_TYPE = 'application/json'

function errorBody(message: string, type: string, code?: string): string {
  return JSON.stringify({ error: { message, type, ...(code !== undefined ? { code } : {}) } })
}

function errorTypeForStatus(status: number): string {
  switch (status) {
    case 400:
    case 404:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 413:
      return 'request_too_large'
    case 429:
      return 'rate_limit_error'
    case 503:
      return 'temporarily_unavailable'
    case 504:
      return 'upstream_timeout'
    default:
      return 'upstream_error'
  }
}

function respondError(res: ServerResponse, status: number, message: string, code?: string, retryAfterSeconds?: number): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE }
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) headers['retry-after'] = String(retryAfterSeconds)
  res.writeHead(status, headers)
  res.end(errorBody(message, errorTypeForStatus(status), code))
}

/** 将 adapter/输出层/图片准入错误统一为 GatewayError 表面。 */
function toGatewayError(error: unknown): GatewayError {
  if (error instanceof StreamFailure) {
    return { status: error.status, code: error.code, message: error.message }
  }
  return mapAdapterError(error)
}

/** 等 drain，与 close/error/取消竞速；停滞客户端不能钉死上游。 */
function waitDrain(res: ServerResponse, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      res.off('drain', finish)
      res.off('close', finish)
      res.off('error', finish)
      signal.removeEventListener('abort', finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = timeoutMs > 0 ? setTimeout(finish, timeoutMs) : undefined
    if (timer === undefined) {
      // 无超时：仅事件驱动
    }
    res.once('drain', finish)
    res.once('close', finish)
    res.once('error', finish)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function readBody(req: IncomingMessage, limitBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (signal.aborted) {
        req.destroy()
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      total += chunk.length
      if (total > limitBytes) {
        // 超限：响应 413 后再销毁连接（fetch 才能收到状态码而非 socket 错误）
        cleanup()
        req.pause()
        reject(Object.assign(new Error('request body exceeds the configured limit'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      req.destroy()
      reject(signal.reason ?? new Error('aborted'))
    }
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onAbort)
      signal.removeEventListener('abort', onAbort)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 启动网关服务器。 */
export function startGateway(options: ServerOptions): Promise<GatewayServer> {
  const { config } = options
  const active = new Set<RequestScope>()
  let shuttingDown = false

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })
  server.keepAliveTimeout = config.keepAliveTimeoutMs
  server.headersTimeout = config.keepAliveTimeoutMs + 5_000

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const method = req.method ?? ''

    // /health：不计入在途限制
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    // /v1/models：只读目录，不占在途额度，鉴权可选（无 Key 用兜底目录）
    if (url === '/v1/models' && method === 'GET') {
      try {
        const models = await (options.listModels?.(extractOptionalKey(req), AbortSignal.timeout(30_000))
          ?? Promise.resolve(FALLBACK_MODELS))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'commandcode' })),
        }))
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: FALLBACK_MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'commandcode' })),
        }))
      }
      return
    }


    if (url !== '/v1/chat/completions' || method !== 'POST') {
      respondError(res, 404, `unknown route ${method} ${url}`)
      return
    }

    if (shuttingDown) {
      respondError(res, 503, 'gateway is shutting down')
      return
    }

    // 鉴权
    const credentials = normalizeCredentials(
      req.headers.authorization,
      typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
    )
    if (!credentials.ok) {
      respondError(res, credentials.status, credentials.message)
      return
    }

    // 在途限制
    if (config.maxInflight > 0 && active.size >= config.maxInflight) {
      respondError(res, 503, 'too many in-flight requests', undefined, 1)
      return
    }

    // 请求作用域
    const scope: RequestScope = { controller: new AbortController() }
    active.add(scope)
    const abortWith = (cause: string) => {
      if (!scope.controller.signal.aborted) scope.controller.abort(cause)
    }
    res.once('close', () => {
      active.delete(scope)
      if (!res.writableFinished) abortWith('client')
    })
    const signal = scope.controller.signal

    try {
      const bodyBuffer = await readBody(req, config.maxBodyBytes, signal)
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyBuffer.toString('utf8'))
      } catch {
        respondError(res, 400, 'request body must be valid JSON')
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        respondError(res, 400, 'request body must be a JSON object')
        return
      }
      const body = parsed as Record<string, unknown>
      const model = body.model
      if (typeof model !== 'string' || model === '') {
        respondError(res, 400, 'model must be a non-empty string')
        return
      }
      const stream = body.stream === true
      const includeUsage = stream && isObject(body.stream_options) && body.stream_options.include_usage === true

      // 转换（含校验）
      let conversion
      try {
        conversion = chatToGenerateOptions(body, model)
      } catch (error) {
        if (isChatRequestError(error)) {
          respondError(res, error.status, error.message)
          return
        }
        throw error
      }

      // 图片准入（鉴权后、上游调用前；作用域内取消传播）
      let imageStore: AttachmentStore | undefined
      if (conversion.imageDataUrls.length > 0) {
        try {
          const admitted = await admitImageDataUrls(conversion.imageDataUrls)
          imageStore = admitted.store
          const byUrl = new Map(conversion.imageDataUrls.map((url, index) => [url, admitted.refs[index]!]))
          conversion = chatToGenerateOptions(body, model, (dataUrl) => byUrl.get(dataUrl))
        } catch (error) {
          if (error instanceof ImageRequestError) {
            respondError(res, 400, error.message)
            return
          }
          throw error
        }
      }

      // adapter 流
      const adapterConfig: AdapterConfig = {
        ...options.adapter,
        streamIdleTimeoutMs: stream ? config.streamIdleTimeoutMs : config.nonStreamIdleTimeoutMs,
      }
      const iterable = streamCommandCode(
        adapterConfig,
        { apiKey: credentials.apiKey, signal },
        conversion.options,
        imageStore !== undefined ? () => imageStore! : undefined,
      )

      if (!stream) {
        try {
          const result = await aggregateToChatJson(iterable, { model })
          if (!res.headersSent) {
            res.writeHead(200, { 'content-type': JSON_CONTENT_TYPE })
          }
          res.end(JSON.stringify(result))
        } catch (error) {
          const gatewayError = toGatewayError(error)
          respondError(res, gatewayError.status, gatewayError.message, gatewayError.code, gatewayError.retryAfterSeconds)
        }
        return
      }

      // SSE
      const encoder = new ChatSseEncoder({ model, includeUsage })
      let opened = false
      const openStream = () => {
        if (opened) return
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        opened = true
      }
      const writeFrame = async (frame: string) => {
        openStream()
        if (!res.write(frame)) {
          await waitDrain(res, signal, config.clientDrainTimeoutMs)
        }
      }

      try {
        for await (const chunk of iterable) {
          const before = encoder.framesLength()
          encoder.push(chunk)
          if (encoder.framesLength() > before) {
            for (const frame of encoder.drainNewFrames()) {
              await writeFrame(frame)
            }
          } else if (opened) {
            // 已开流且上游有数据但无可见输出：注释心跳
            res.write(': keepalive\n\n')
          }
        }
        encoder.fail()
        const outcome = encoder.result().outcome
        if (outcome.kind === 'success') {
          for (const frame of encoder.drainNewFrames()) {
            await writeFrame(frame)
          }
          res.end()
        } else {
          // 流结束但无成功终态：开流前是 JSON 错误；已开流则错误帧 + 正常关闭
          if (!opened) {
            throw new StreamFailure(502, 'stream_terminated_early', 'commandcode stream ended without a successful finish')
          }
          res.write(`data: ${errorBody('commandcode stream ended without a successful finish', 'upstream_error', 'stream_terminated_early')}\n\n`)
          res.end()
        }
      } catch (error) {
        if (!opened) {
          const gatewayError = toGatewayError(error)
          respondError(res, gatewayError.status, gatewayError.message, gatewayError.code, gatewayError.retryAfterSeconds)
          return
        }
        // 已开流：错误帧 + 正常响应关闭（保证缓冲中的帧送达），不追加 [DONE]
        const gatewayError = toGatewayError(error)
        res.write(`data: ${errorBody(gatewayError.message, errorTypeForStatus(gatewayError.status), gatewayError.code)}\n\n`)
        res.end()
      } finally {
        await (iterable as AsyncIterable<unknown> & { return?: () => Promise<unknown> }).return?.().catch(() => undefined)
      }
      return
    } catch (error) {
      if (signal.aborted) {
        res.destroy()
        return
      }
      // readBody 的 413 带状态标记，直接按它响应
      if (error instanceof Error && typeof (error as { status?: unknown }).status === 'number') {
        const status = (error as unknown as { status: number }).status
        respondError(res, status, error.message)
        return
      }
      const gatewayError = toGatewayError(error)
      respondError(res, gatewayError.status, gatewayError.message, gatewayError.code, gatewayError.retryAfterSeconds)
    } finally {
      active.delete(scope)
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : config.port
      resolve({
        server,
        address: { host: config.host, port },
        close: (graceMs: number) =>
          new Promise((resolveClose) => {
            shuttingDown = true
            server.close(() => resolveClose('clean'))
            if (active.size === 0) {
              resolveClose('clean')
              return
            }
            const timer = setTimeout(() => {
              for (const scope of active) {
                if (!scope.controller.signal.aborted) scope.controller.abort('shutdown')
              }
              resolveClose('forced')
            }, graceMs)
            const poll = setInterval(() => {
              if (active.size === 0) {
                clearInterval(poll)
                clearTimeout(timer)
                resolveClose('clean')
              }
            }, 25)
          }),
      })
    })
  })
}

function extractOptionalKey(req: IncomingMessage): string | undefined {
  const credentials = normalizeCredentials(
    req.headers.authorization,
    typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
  )
  return credentials.ok ? credentials.apiKey : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 固定兜底目录（proxy 锁定版内置模型表）。 */
const FALLBACK_MODELS: { id: string }[] = FALLBACK_MODEL_IDS.map((id) => ({ id }))
