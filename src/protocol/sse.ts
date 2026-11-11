/**
 * 流式 Chat SSE 编码：DSH StreamChunk → Chat Completions SSE 帧。
 * 每帧一个完整事件（单行 data），响应 id/created/model 全流稳定，
 * 工具 index 只对 tool 块从 0 顺序分配，固定终序：
 * finish_reason 帧 → 可选空 choices usage 帧 → 恰好一个 [DONE]。
 * 失败路径不发 [DONE]；纯编码器，I/O（开流、心跳、背压）在 server。
 */

import type { FinishReason, StreamChunk, TokenUsage } from '../runtime.ts'
import { finishToChatReason, isJsonObjectString, usageToChat } from './output.ts'

export interface SseEncodeResult {
  /** 已编码帧；失败时流停止且无 [DONE]。 */
  frames: string[]
  /** 成功终态（含 reason/usage）或失败。 */
  outcome: { kind: 'success'; reason: 'stop' | 'tool_calls' | 'length'; usage?: TokenUsage } | { kind: 'failure' }
}

export interface SseEncoderOptions {
  model: string
  includeUsage: boolean
}

interface ToolState {
  chatIndex: number
  id: string
  name: string
  /** 已发给客户端的参数（deltas 拼接）。 */
  argumentsSent: string
  /** 块以与已发内容一致的参数闭合后置位。 */
  closed: boolean
  /** 至少一帧非空内容到达客户端后置位。 */
  dispatched: boolean
}

function baseChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/**
 * 增量编码器。push() 按流序喂入每个 chunk，帧累积到终态。
 * 失败 outcome（error finish、缺 finish、畸形工具状态）停止输出且无 [DONE]。
 */
export class ChatSseEncoder {
  private readonly id = `chatcmpl-${crypto.randomUUID()}`
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly model: string
  private readonly includeUsage: boolean
  private readonly frames: string[] = []
  private readonly tools = new Map<number, ToolState>()
  private nextToolIndex = 0
  private roleSent = false
  private usage?: TokenUsage
  private finished = false
  private failed = false
  private flushed = 0

  constructor(options: SseEncoderOptions) {
    this.model = options.model
    this.includeUsage = options.includeUsage
  }

  private emit(delta: Record<string, unknown>, finishReason: string | null = null): void {
    this.frames.push(`data: ${JSON.stringify(baseChunk(this.id, this.created, this.model, delta, finishReason))}\n\n`)
  }

  private ensureRole(): void {
    if (this.roleSent) return
    this.emit({ role: 'assistant' })
    this.roleSent = true
  }

  /** 处理一个 chunk；结束时用 result() 读取结果。 */
  push(chunk: StreamChunk): void {
    if (this.finished || this.failed) return
    switch (chunk.type) {
      case 'text-delta': {
        this.ensureRole()
        this.emit({ content: chunk.text })
        break
      }
      case 'reasoning-delta': {
        this.ensureRole()
        this.emit({ reasoning_content: chunk.text })
        break
      }
      case 'tool-call-delta': {
        this.ensureRole()
        let tool = this.tools.get(chunk.index)
        if (!tool) {
          tool = { chatIndex: this.nextToolIndex++, id: chunk.id as string, name: chunk.name ?? '', argumentsSent: '', closed: false, dispatched: false }
          this.tools.set(chunk.index, tool)
          this.emit({ tool_calls: [{ index: tool.chatIndex, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] })
        }
        if (tool.closed) {
          // 已闭合块后再来 delta：元数据不一致。
          this.failed = true
          return
        }
        if (chunk.id !== tool.id || (chunk.name !== undefined && chunk.name !== '' && chunk.name !== tool.name && tool.name !== '')) {
          this.failed = true
          return
        }
        if (chunk.argumentsDelta !== '') {
          tool.argumentsSent += chunk.argumentsDelta
          tool.dispatched = true
          this.emit({ tool_calls: [{ index: tool.chatIndex, function: { arguments: chunk.argumentsDelta } }] })
        }
        break
      }
      case 'block-end': {
        if (chunk.block.type !== 'tool-call') break
        this.ensureRole()
        const existing = this.tools.get(chunk.index)
        const full = chunk.block
        if (!isJsonObjectString(full.arguments)) {
          // 完整工具参数必须解码为 JSON object。
          this.failed = true
          return
        }
        if (!existing) {
          // 无前置 delta 的完整块：一次性发全量。
          const chatIndex = this.nextToolIndex++
          this.tools.set(chunk.index, { chatIndex, id: full.id as string, name: full.name, argumentsSent: full.arguments, closed: true, dispatched: true })
          this.emit({ tool_calls: [{ index: chatIndex, id: full.id as string, type: 'function', function: { name: full.name, arguments: full.arguments } }] })
          break
        }
        if (existing.closed || full.id !== existing.id) {
          this.failed = true
          return
        }
        if (existing.name === '' && full.name !== '') {
          this.emit({ tool_calls: [{ index: existing.chatIndex, function: { name: full.name } }] })
          existing.name = full.name
        } else if (existing.name !== '' && full.name !== existing.name) {
          this.failed = true
          return
        }
        if (existing.argumentsSent === '') {
          existing.argumentsSent = full.arguments
          existing.dispatched = true
          this.emit({ tool_calls: [{ index: existing.chatIndex, function: { arguments: full.arguments } }] })
        } else if (existing.argumentsSent !== full.arguments) {
          // deltas 与完整块不一致：元数据不一致。
          this.failed = true
          return
        }
        existing.closed = true
        break
      }
      case 'usage': {
        this.usage = chunk.usage
        break
      }
      case 'finish': {
        const reason = finishToChatReason(chunk.reason as FinishReason)
        if (reason === null) {
          this.failed = true
          return
        }
        if (reason === 'tool_calls') {
          // 工具终态要求所有已派发工具闭合且参数一致。
          const allClosed = this.tools.size > 0 && [...this.tools.values()].every((tool) => tool.closed && tool.dispatched)
          if (!allClosed) {
            this.failed = true
            return
          }
        }
        this.finished = true
        this.emit({}, reason)
        if (this.includeUsage && this.usage !== undefined) {
          this.frames.push(`data: ${JSON.stringify({
            id: this.id,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [],
            usage: usageToChat(this.usage),
          })}\n\n`)
        }
        this.frames.push('data: [DONE]\n\n')
        break
      }
      default:
        break
    }
  }

  /** 标记流结束但没有成功 finish（不发 [DONE]）。 */
  fail(): void {
    if (this.finished) return
    this.failed = true
  }

  /** 已编码帧数。 */
  framesLength(): number {
    return this.frames.length
  }

  /** 返回尚未冲刷的帧并标记已冲刷。 */
  drainNewFrames(): string[] {
    const out = this.frames.slice(this.flushed)
    this.flushed = this.frames.length
    return out
  }

  result(): SseEncodeResult {
    if (this.failed || !this.finished) {
      return { frames: this.frames, outcome: { kind: 'failure' } }
    }
    const reason = this.extractReason()
    return {
      frames: this.frames,
      outcome: { kind: 'success', reason: reason ?? 'stop', usage: this.usage },
    }
  }

  private extractReason(): 'stop' | 'tool_calls' | 'length' | null {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const frame = this.frames[index]
      if (!frame.startsWith('data: ') || frame.includes('[DONE]')) continue
      try {
        const parsed = JSON.parse(frame.slice(6)) as { choices?: Array<{ finish_reason?: string }> }
        const finish = parsed.choices?.[0]?.finish_reason
        if (finish === 'stop' || finish === 'tool_calls' || finish === 'length') return finish
      } catch { /* 内部帧畸形（理论不可达） */ }
    }
    return null
  }
}
