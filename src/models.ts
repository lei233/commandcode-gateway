/**
 * 模型目录：全局内存缓存 + TTL 刷新 + 固定列表兜底。
 *
 * 缓存不按 Key 隔离（见 docs/architecture.md），内容为目录元数据，
 * 不持有请求凭据或 adapter 实例。未命中有效缓存时经当前请求的 adapter
 * 拉取；失败、空目录、无 Key 或关闭动态发现时返回固定列表。目录接口
 * 不承担 Key 有效性校验，生成请求不以目录命中为前提。
 */

import { listCommandCodeModels } from './commandcode.ts'
import type { AdapterConfig } from './commandcode.ts'
import type { GatewayConfig } from './config.ts'

/** 内置固定模型表（动态目录不可用时的兜底）。 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'moonshotai/Kimi-K2.6',
  'Kimi-K2.5',
  'zai-org/GLM-5.1',
  'GLM-5',
  'MiniMaxAI/MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen3.6-Plus',
  'Qwen3.7-Max',
  'stepfun/Step-3.7-Flash',
  'Step-3.5-Flash',
  'xiaomi/mimo-v2.5-pro',
  'mimo-v2.5',
  'google/gemini-3.5-flash',
  'gemini-3.1-flash-lite',
]

interface CatalogCache {
  ids: string[]
  fetchedAt: number
}

/** 全局缓存（模块级，不按 Key 隔离）；仅目录元数据。 */
let cache: CatalogCache | undefined

/** 测试钩子：清空全局缓存。 */
export function resetModelCache(): void {
  cache = undefined
}

/** 当前缓存快照（测试用）。 */
export function modelCacheSnapshot(): CatalogCache | undefined {
  return cache
}

function withinTtl(entry: CatalogCache, ttlMs: number, now: number): boolean {
  return now - entry.fetchedAt < ttlMs
}

/**
 * 解析 /v1/models 目录：
 * 1. 关闭动态发现 → 固定列表；
 * 2. 有效缓存 → 缓存；
 * 3. 有 Key → adapter 拉取，成功且非空 → 更新缓存并返回；
 * 4. 其余（无 Key、失败、空目录）→ 固定列表。
 */
export async function resolveModelCatalog(
  config: GatewayConfig,
  adapter: AdapterConfig,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  const now = Date.now()
  if (!config.useProviderModels) {
    return [...FALLBACK_MODEL_IDS]
  }
  if (cache !== undefined && withinTtl(cache, config.modelRefreshIntervalMs, now)) {
    return [...cache.ids]
  }
  if (apiKey !== undefined) {
    try {
      const models = await listCommandCodeModels({ ...adapter, streamIdleTimeoutMs: 30_000 }, { apiKey, signal })
      const ids = models.map((m) => m.id).filter((id) => id !== '')
      if (ids.length > 0) {
        cache = { ids, fetchedAt: Date.now() }
        return [...ids]
      }
    } catch {
      // adapter 不可用或调用失败：落到固定列表（不视为刷新成功）
    }
  }
  return [...FALLBACK_MODEL_IDS]
}
