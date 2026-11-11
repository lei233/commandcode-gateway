/**
 * 配置解析：内置默认值 → config.json → 环境变量，依次覆盖。
 * 资源限制经环境变量配置；仓库 config.json 预设监听 0.0.0.0:3050。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 网关运行配置（解析完成后的规范化形态）。 */
export interface GatewayConfig {
  /** 监听地址。 */
  host: string
  /** 监听端口，1–65535。 */
  port: number
  /** 请求体上限（字节），超限返回 413。 */
  maxBodyBytes: number
  /** 流式生成上游读空闲超时（毫秒）。 */
  streamIdleTimeoutMs: number
  /** 非流式生成上游读空闲超时（毫秒）。 */
  nonStreamIdleTimeoutMs: number
  /** 在途生成请求上限，0 表示不限制。 */
  maxInflight: number
  /** 下游背压等待超时（毫秒），0 表示关闭。 */
  clientDrainTimeoutMs: number
  /** HTTP keep-alive 超时（毫秒）。 */
  keepAliveTimeoutMs: number
  /** 是否启用动态模型目录。 */
  useProviderModels: boolean
  /** 模型目录缓存有效期（毫秒）。 */
  modelRefreshIntervalMs: number
  /** 上游 Provider API 根地址。 */
  apiBase: string
  /** 上报给上游的项目工作目录。 */
  workingDir: string
  /** adapter 模型目录磁盘缓存路径。 */
  modelsCachePath: string
}

interface ConfigFileShape {
  host?: unknown
  port?: unknown
  useProviderModels?: unknown
  modelRefreshIntervalMs?: unknown
  apiBase?: unknown
  workingDir?: unknown
  modelsCachePath?: unknown
}

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 3000
const DEFAULT_MAX_BODY_MB = 100
const DEFAULT_STREAM_IDLE_MS = 30_000
const DEFAULT_NONSTREAM_IDLE_MS = 90_000
const DEFAULT_MAX_INFLIGHT = 0
const DEFAULT_DRAIN_TIMEOUT_MS = 0
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 65_000
const DEFAULT_USE_PROVIDER_MODELS = true
const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 300_000
const DEFAULT_API_BASE = 'https://api.commandcode.ai'
const DEFAULT_WORKING_DIR = '/workspace'
const DEFAULT_MODELS_CACHE_PATH = resolve(process.env['HOME'] ?? '.', '.commandcode', 'models-cache.json')

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return fallback
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number, opts?: { allowZero?: boolean }): number {
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  const allowZero = opts?.allowZero ?? false
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) return fallback
  return value
}

function readConfigFile(path: string): ConfigFileShape {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ConfigFileShape
    }
    throw new Error('config.json root must be an object')
  } catch (error) {
    throw new Error(`cannot load config file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 解析配置。读取顺序：内置默认值 → `configFilePath`（通常为仓库 config.json）→ 环境变量。
 * 文件或环境变量取值非法时使用默认值，不中断启动。
 */
export function loadConfig(configFilePath: string, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const file = readConfigFile(configFilePath)
  const filePort = typeof file.port === 'number' && Number.isInteger(file.port) && file.port >= 1 && file.port <= 65535
    ? file.port
    : undefined
  const fileRefresh = typeof file.modelRefreshIntervalMs === 'number'
    && Number.isInteger(file.modelRefreshIntervalMs) && file.modelRefreshIntervalMs > 0
    ? file.modelRefreshIntervalMs
    : undefined
  const fileUseProviderModels = typeof file.useProviderModels === 'boolean' ? file.useProviderModels : undefined
  const fileHost = typeof file.host === 'string' && file.host.length > 0 ? file.host : undefined
  const fileApiBase = typeof file.apiBase === 'string' && file.apiBase.startsWith('https://') ? file.apiBase : undefined
  const fileWorkingDir = typeof file.workingDir === 'string' && file.workingDir.length > 0 ? file.workingDir : undefined
  const fileModelsCachePath = typeof file.modelsCachePath === 'string' && file.modelsCachePath.length > 0
    ? file.modelsCachePath
    : undefined

  const port = parsePositiveIntEnv(env['PORT'], filePort ?? DEFAULT_PORT)
  const host = env['HOST'] !== undefined && env['HOST'] !== '' ? env['HOST'] : fileHost ?? DEFAULT_HOST

  return {
    host,
    port,
    maxBodyBytes: parsePositiveIntEnv(env['CC_MAX_BODY_MB'], DEFAULT_MAX_BODY_MB) * 1024 * 1024,
    streamIdleTimeoutMs: parsePositiveIntEnv(env['CC_STREAM_IDLE_MS'], DEFAULT_STREAM_IDLE_MS),
    nonStreamIdleTimeoutMs: parsePositiveIntEnv(env['CC_NONSTREAM_IDLE_MS'], DEFAULT_NONSTREAM_IDLE_MS),
    maxInflight: parsePositiveIntEnv(env['CC_MAX_INFLIGHT'], DEFAULT_MAX_INFLIGHT, { allowZero: true }),
    clientDrainTimeoutMs: parsePositiveIntEnv(env['CC_CLIENT_DRAIN_TIMEOUT_MS'], DEFAULT_DRAIN_TIMEOUT_MS, { allowZero: true }),
    keepAliveTimeoutMs: parsePositiveIntEnv(env['CC_KEEPALIVE_TIMEOUT_MS'], DEFAULT_KEEPALIVE_TIMEOUT_MS),
    useProviderModels: env['CC_USE_PROVIDER_MODELS'] !== undefined
      ? parseBooleanEnv(env['CC_USE_PROVIDER_MODELS'], DEFAULT_USE_PROVIDER_MODELS)
      : fileUseProviderModels ?? DEFAULT_USE_PROVIDER_MODELS,
    modelRefreshIntervalMs: parsePositiveIntEnv(env['CC_MODEL_REFRESH_INTERVAL_MS'], fileRefresh ?? DEFAULT_MODEL_REFRESH_INTERVAL_MS),
    apiBase: env['CC_API_BASE'] !== undefined && env['CC_API_BASE'] !== ''
      ? env['CC_API_BASE']
      : fileApiBase ?? DEFAULT_API_BASE,
    workingDir: env['CC_WORKING_DIR'] !== undefined && env['CC_WORKING_DIR'] !== '' ? env['CC_WORKING_DIR'] : fileWorkingDir ?? DEFAULT_WORKING_DIR,
    modelsCachePath: env['CC_MODELS_CACHE_PATH'] !== undefined && env['CC_MODELS_CACHE_PATH'] !== ''
      ? env['CC_MODELS_CACHE_PATH']
      : fileModelsCachePath ?? DEFAULT_MODELS_CACHE_PATH,
  }
}
