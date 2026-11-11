/**
 * JSON/SSE 共用的输出语义：成功终态判定、finish reason 映射、usage 换算
 * 与共享失败载体。两个编码器（complete/sse）从这里取同一套判定，避免
 * 行为分叉。
 */

import type { FinishReason, TokenUsage } from '../runtime.ts'

/** Chat Completions 对外的三种成功结束原因。 */
export type ChatFinishReason = 'stop' | 'tool_calls' | 'length'

/** 输出层的结构化失败；server 层据此渲染 JSON 错误体与状态码。 */
export class StreamFailure extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'StreamFailure'
    this.status = status
    this.code = code
  }
}

/** 聚合输出字节上限，超限取消迭代（502）。 */
export const MAX_AGGREGATED_BYTES = 32 << 20

/**
 * finish reason → Chat 三值；error/aborted 返回 null（调用方按失败处理）。
 */
export function finishToChatReason(reason: FinishReason): ChatFinishReason | null {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    default: return null
  }
}

/** Chat usage：prompt = 未缓存输入 + cache 读 + cache 写（DSH 三字段不相交）。 */
export function usageToChat(usage: TokenUsage): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} {
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? prompt + usage.outputTokens,
  }
}

/** adapter 可呈现的取消形态：符号化 reason、AbortError、TimeoutError。 */
export function isCancelLike(error: unknown): boolean {
  return error === 'deadline' || error === 'client' || error === 'shutdown'
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

/** 完整字符串必须是可解码的 JSON object（工具参数完整性判定，JSON/SSE 共用）。 */
export function isJsonObjectString(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}
