/**
 * 非流式 Chat JSON 聚合：用 BlockAssembler 消费 DSH StreamChunk，
 * 校验成功终态后渲染单个 chat.completion 对象。
 * 终态判定、usage 换算与失败载体来自共享的 output.ts。
 */

import { BlockAssembler } from '../runtime.ts'
import { mapAdapterError } from '../commandcode.ts'

import type { FinishReason, StreamChunk } from '../runtime.ts'
import { MAX_AGGREGATED_BYTES, StreamFailure, finishToChatReason, isCancelLike, usageToChat } from './output.ts'

export interface ChatJsonResult {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      reasoning_content?: string
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
    finish_reason: 'stop' | 'tool_calls' | 'length'
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface AggregateOptions {
  model: string
  /** 聚合输出字节上限；缺省 MAX_AGGREGATED_BYTES。 */
  maxBytes?: number
}

/**
 * 消费 adapter 迭代器至完成并渲染 Chat JSON。error/aborted finish、缺成功
 * 终态、提前结束或超限输出抛 StreamFailure。
 */
export async function aggregateToChatJson(
  iterable: AsyncIterable<StreamChunk>,
  options: AggregateOptions,
): Promise<ChatJsonResult> {
  const assembler = new BlockAssembler()
  const cap = options.maxBytes ?? MAX_AGGREGATED_BYTES
  let sawSuccessfulFinish = false
  let finishReason: FinishReason | undefined
  let bytes = 0
  let open = false

  try {
    for await (const chunk of iterable) {
      switch (chunk.type) {
        case 'finish': {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            throw new StreamFailure(502, 'upstream_error', 'commandcode upstream reported a failed finish')
          }
          sawSuccessfulFinish = true
          finishReason = chunk.reason
          break
        }
        case 'text-delta':
        case 'reasoning-delta':
          bytes += chunk.text.length
          break
        case 'tool-call-delta':
          bytes += chunk.argumentsDelta.length
          break
        default:
          break
      }
      if (bytes > cap) {
        throw new StreamFailure(502, 'output_too_large', 'commandcode aggregated output exceeded the configured limit')
      }
      assembler.push(chunk)
      open = true
    }
  } catch (error) {
    if (error instanceof StreamFailure) throw error
    // adapter 结构化失败（401/403/429 + retry-after）保留自身分类上抛。
    if (error instanceof Error && error.name === 'LlmError' && typeof (error as { failure?: { status?: number } }).failure?.status === 'number') {
      throw error
    }
    // 取消带原因（deadline/client/shutdown 或 AbortError）：按直接 adapter
    // 错误映射，保证开流前 deadline 是结构化 504 而非 502。
    if (isCancelLike(error)) {
      const mapped = mapAdapterError(error)
      throw new StreamFailure(mapped.status, mapped.code, mapped.message)
    }
    throw new StreamFailure(502, 'upstream_unavailable', 'commandcode upstream stream failed')
  } finally {
    if (open && typeof (iterable as AsyncIterable<StreamChunk> & { return?: () => Promise<unknown> }).return === 'function') {
      await (iterable as AsyncIterable<StreamChunk> & { return(): Promise<unknown> }).return?.()
    }
  }

  if (!sawSuccessfulFinish) {
    throw new StreamFailure(502, 'stream_terminated_early', 'commandcode stream ended without a successful finish')
  }

  const blocks = assembler.blocks()
  const text = blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('')
  const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => (b.type === 'reasoning' ? b.text : '')).join('')
  const toolCalls: NonNullable<ChatJsonResult['choices'][number]['message']['tool_calls']> = []
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    toolCalls.push({
      id: block.id as string,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    })
  }

  // assembler 在 max-tokens 截断时丢弃不安全调用，但 finish 仍报 length；
  // tool_calls finish 要求调用存活。
  const finish = finishToChatReason(finishReason ?? { kind: 'stop' }) ?? 'stop'
  if (finish === 'tool_calls' && toolCalls.length === 0) {
    throw new StreamFailure(502, 'incomplete_tool_calls', 'commandcode tool-call finish carried no usable tool calls')
  }

  const message: ChatJsonResult['choices'][number]['message'] = {
    role: 'assistant',
    content: text === '' && toolCalls.length > 0 ? null : text,
  }
  if (reasoning !== '') message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const result: ChatJsonResult = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, message, finish_reason: finish }],
  }
  const usage = assembler.usage
  if (usage !== undefined) result.usage = usageToChat(usage)
  return result
}
