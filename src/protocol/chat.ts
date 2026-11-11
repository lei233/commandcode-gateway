/**
 * Chat Completions 请求校验与转换为 DSH GenerateOptions。
 *
 * 行为基准为参考 Worker 的校验状态机：system/developer 文本按序合并，
 * user/assistant 文本与 assistant reasoning_content 转为 DSH 内容块，
 * tool_calls 保留原始 id 与顺序，role:tool 按 tool_call_id 配对；
 * 批次必须在下一条普通消息或新批次前闭合。网关差异：
 * - 采样参数映射 GenerateOptions 已有字段（temperature / reasoning_effort /
 *   max_tokens / stop），无正式映射能力的参数明确 400，不静默丢弃；
 * - 用户消息 image_url parts 保留原始顺序：base64 data URL 收集为
 *   `ImageDataUrl[]`（由 images.ts 转为附件引用），HTTP(S) 外链立即 400。
 */

import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '../runtime.ts'

import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from '../runtime.ts'

export interface ChatRequestError {
  status: 400
  message: string
}

export interface ChatConversion {
  options: Omit<GenerateOptions, 'signal'>
  /** 用户消息中的 data URL 图片，按出现顺序排列；由 images.ts 接管。 */
  imageDataUrls: string[]
}

const MAX_TOOL_CALL_ID_LENGTH = 64

/** 网关无映射能力、收到即 400 的顶层生成控制参数。 */
const UNSUPPORTED_PARAMS: readonly string[] = [
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'seed',
  'response_format',
  'parallel_tool_calls',
  'user',
  'store',
  'metadata',
]

const SUPPORTED_EFFORTS: readonly string[] = ['low', 'medium', 'high']

interface ChatMessage {
  role: string
  content?: unknown
  reasoning_content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): ChatRequestError {
  return { status: 400, message }
}

export function isChatRequestError(value: unknown): value is ChatRequestError {
  return isObject(value) && value.status === 400 && typeof value.message === 'string'
}

/** Converts one assistant tool_calls array into validated raw call records. */
function parseToolCalls(raw: unknown, message: string): Array<{ id: string; name: string; arguments: object }> {
  if (!Array.isArray(raw)) throw invalid(`${message}: tool_calls must be an array`)
  const calls = []
  for (const call of raw) {
    if (!isObject(call)) throw invalid(`${message}: tool_calls entries must be objects`)
    const id = call.id
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TOOL_CALL_ID_LENGTH) {
      throw invalid(`${message}: tool call id must be a non-empty string of at most ${MAX_TOOL_CALL_ID_LENGTH} characters`)
    }
    const fn = call.function
    if (!isObject(fn) || typeof fn.name !== 'string' || fn.name.length === 0) {
      throw invalid(`${message}: tool call requires a function name`)
    }
    let parsed: unknown
    if (typeof fn.arguments === 'string') {
      try {
        parsed = JSON.parse(fn.arguments)
      } catch {
        throw invalid(`${message}: tool call arguments must be a JSON string`)
      }
    } else {
      parsed = fn.arguments
    }
    if (!isObject(parsed)) throw invalid(`${message}: tool call arguments must decode to a JSON object`)
    calls.push({ id, name: fn.name, arguments: parsed })
  }
  return calls
}

/** user 消息 content：文本 part 与 data URL 图片 part 按原始顺序收集。 */
function userContent(
  content: unknown,
  label: string,
  imageDataUrls: string[],
): Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content === null || content === undefined) return []
  if (!Array.isArray(content)) {
    throw invalid(`${label}: content must be a string or an array of content parts`)
  }
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }> = []
  for (const part of content) {
    if (!isObject(part)) throw invalid(`${label}: content parts must be objects`)
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw invalid(`${label}: text content part requires a string text`)
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image_url') {
      const url = isObject(part.image_url) ? part.image_url.url : undefined
      if (typeof url !== 'string' || url === '') {
        throw invalid(`${label}: image_url part requires image_url.url`)
      }
      if (/^https?:\/\//i.test(url)) {
        throw invalid(`${label}: HTTP(S) image URLs are not supported; send base64 data URLs (first release)`)
      }
      if (!url.startsWith('data:')) {
        throw invalid(`${label}: image_url.url must be a base64 data URL`)
      }
      // detail 兼容接收但不映射上游，不校验取值。
      parts.push({ type: 'image', dataUrl: url })
      imageDataUrls.push(url)
      continue
    }
    throw invalid(`${label}: content part type ${JSON.stringify(part.type)} is not supported`)
  }
  return parts
}

/** 非 user 消息 content：仅文本 part（含 Responses 风格 text 别名）。 */
function textParts(content: unknown, label: string): string[] {
  if (typeof content === 'string') return [content]
  if (content === null || content === undefined) return []
  if (!Array.isArray(content)) {
    throw invalid(`${label}: content must be a string or an array of content parts`)
  }
  const parts: string[] = []
  for (const part of content) {
    if (!isObject(part)) throw invalid(`${label}: content parts must be objects`)
    if (part.type !== 'text' && part.type !== 'input_text' && part.type !== 'output_text') {
      throw invalid(`${label}: content part type ${JSON.stringify(part.type)} is not supported (text only in the first release)`)
    }
    if (typeof part.text !== 'string') throw invalid(`${label}: text content part requires a string text`)
    parts.push(part.text)
  }
  return parts
}

/**
 * 校验 Chat Completions body 并转换为 GenerateOptions 字段与图片 data URL 列表。
 * 任何不支持或畸形的输入以 ChatRequestError 抛出（isChatRequestError 识别）。
 */
export function chatToGenerateOptions(body: unknown, model: string): ChatConversion {
  if (!isObject(body)) throw invalid('request body must be a JSON object')
  if (body.n !== undefined && body.n !== 1) throw invalid('only a single candidate (n=1) is supported')

  for (const param of UNSUPPORTED_PARAMS) {
    if (body[param] !== undefined) {
      throw invalid(`${param} is not supported by this gateway`)
    }
  }

  // Tool declarations: function tools only.
  let tools: ToolSchema[] | undefined
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw invalid('tools must be an array')
    tools = body.tools.map((tool, index) => {
      const label = `tools[${index}]`
      if (!isObject(tool)) throw invalid(`${label}: must be an object`)
      if (tool.type !== 'function') throw invalid(`${label}: only function tools are supported`)
      const fn = tool.function
      if (!isObject(fn) || typeof fn.name !== 'string' || fn.name.length === 0) {
        throw invalid(`${label}: function name is required`)
      }
      if (typeof fn.description !== 'string' && fn.description !== undefined) {
        throw invalid(`${label}: function description must be a string`)
      }
      if (!isObject(fn.parameters)) throw invalid(`${label}: function parameters must be a JSON schema object`)
      return { name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: fn.parameters }
    })
  }

  // Tool choice: 'auto'/缺省保留声明；'none' 删除当轮声明但保留历史调用与结果；
  // forced choice 拒绝。
  let toolChoice: 'auto' | 'none' = 'auto'
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice
    const forcedObject = isObject(choice) && (choice.type === 'function' || choice.type === 'tool')
    if (forcedObject) throw invalid('forced tool_choice is not supported in the first release')
    if (choice !== 'auto' && choice !== 'none' && choice !== null) {
      throw invalid('tool_choice must be "auto" or "none"')
    }
    if (choice === 'none') toolChoice = 'none'
  }
  if (toolChoice === 'none') tools = undefined

  // Max tokens: explicit max_completion_tokens wins over max_tokens.
  let maxTokens: number | undefined
  const explicit = body.max_completion_tokens ?? body.max_tokens
  if (explicit !== undefined) {
    if (typeof explicit !== 'number' || !Number.isSafeInteger(explicit) || explicit <= 0) {
      throw invalid('max_completion_tokens/max_tokens must be a positive integer')
    }
    maxTokens = explicit
  }

  // Temperature: finite number, 0..2 (OpenAI range), mapped verbatim.
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      throw invalid('temperature must be a number between 0 and 2')
    }
  }

  // Stop sequences: string or array of strings, mapped to string[].
  let stop: string[] | undefined
  if (body.stop !== undefined && body.stop !== null) {
    if (typeof body.stop === 'string') {
      stop = [body.stop]
    } else if (Array.isArray(body.stop) && body.stop.every((item): item is string => typeof item === 'string')) {
      stop = body.stop
    } else {
      throw invalid('stop must be a string or an array of strings')
    }
  }

  // Reasoning effort: explicit level names mapped verbatim.
  let reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    if (typeof body.reasoning_effort !== 'string' || !SUPPORTED_EFFORTS.includes(body.reasoning_effort)) {
      throw invalid(`reasoning_effort must be one of ${SUPPORTED_EFFORTS.map((e) => JSON.stringify(e)).join(', ')}`)
    }
    reasoningEffort = ReasoningEffortId(body.reasoning_effort)
  }

  if (!Array.isArray(body.messages)) throw invalid('messages must be an array')
  if (body.messages.length === 0) throw invalid('messages must not be empty')

  const messages: RequestMessage[] = []
  const seenIds = new Set<string>()
  // 批次：每条带 tool_calls 的 assistant 消息开启一个批次；批次必须完全回填
  // （顺序任意）后，普通消息或新批次才可出现。
  const openBatch = new Map<string, { name: string }>()
  const systemParts: string[] = []
  const imageDataUrls: string[] = []

  const requireClosedBatch = (label: string) => {
    if (openBatch.size === 0) return
    const ids = [...openBatch.keys()].map((id) => JSON.stringify(id)).join(', ')
    throw invalid(`${label}: the previous tool call batch must be fully backfilled first (open: ${ids})`)
  }

  for (let index = 0; index < body.messages.length; index++) {
    const raw = body.messages[index]
    const label = `messages[${index}]`
    if (!isObject(raw)) throw invalid(`${label}: must be an object`)
    const message = raw as unknown as ChatMessage
    const role = message.role

    if (role === 'system' || role === 'developer') {
      const text = textParts(message.content, label).join('\n')
      if (text !== '') systemParts.push(text)
      continue
    }

    if (role === 'user') {
      requireClosedBatch(label)
      const parts = userContent(message.content, label, imageDataUrls)
      // M1：图片只收集为 data URL 列表（M4 由 images.ts 构造带附件引用的
      // ImageBlock 并重建消息）；此处先落文本块占位顺序。
      const blocks: ContentBlock[] = parts.map((part): ContentBlock =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'text', text: `[image ${imageDataUrls.indexOf(part.dataUrl)}]` },
      )
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      messages.push(createUserMessage({ content: blocks, source: { kind: 'user' } }))
      continue
    }

    if (role === 'assistant') {
      requireClosedBatch(label)
      const blocks: ContentBlock[] = []
      if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
        if (typeof message.reasoning_content !== 'string') throw invalid(`${label}: reasoning_content must be a string`)
        if (message.reasoning_content !== '') blocks.push({ type: 'reasoning', text: message.reasoning_content })
      }
      const text = textParts(message.content, label).join('\n')
      if (text !== '') blocks.push({ type: 'text', text })
      let calls: Array<{ id: string; name: string; arguments: object }> = []
      if (message.tool_calls !== undefined && message.tool_calls !== null) {
        calls = parseToolCalls(message.tool_calls, label)
        for (const call of calls) {
          if (seenIds.has(call.id)) throw invalid(`${label}: duplicate tool call id ${JSON.stringify(call.id)}`)
          seenIds.add(call.id)
          openBatch.set(call.id, { name: call.name })
          blocks.push({ type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.arguments) })
        }
      }
      if (message.content === null && calls.length === 0) throw invalid(`${label}: content:null requires tool_calls`)
      messages.push(createAssistantMessage({
        content: blocks,
        source: { provider: 'commandcode', model },
      }))
      continue
    }

    if (role === 'tool') {
      const id = message.tool_call_id
      if (typeof id !== 'string' || id.length === 0) throw invalid(`${label}: tool_call_id is required`)
      const pending = openBatch.get(id)
      if (!pending) throw invalid(`${label}: tool_call_id ${JSON.stringify(id)} does not match an unresolved tool call`)
      const text = textParts(message.content, label).join('\n')
      openBatch.delete(id)
      messages.push(createToolResultMessage({
        callId: ToolCallId(id),
        content: text === '' ? [] : [{ type: 'text', text }],
        isError: false,
      }))
      continue
    }

    throw invalid(`${label}: unsupported role ${JSON.stringify(role)}`)
  }

  if (openBatch.size > 0) {
    const ids = [...openBatch.keys()].map((id) => JSON.stringify(id)).join(', ')
    throw invalid(`tool calls without results before the end of the request: ${ids}`)
  }

  const options: Omit<GenerateOptions, 'signal'> = {
    provider: 'commandcode',
    model,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n') } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature as number } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
  return { options, imageDataUrls }
}

/** Parses tool results out of a converted message list (test helper). */
export function toolResultText(message: RequestMessage): string | undefined {
  if (message.role !== 'tool') return undefined
  const first = message.content.find((block) => block.type === 'text')
  return first && first.type === 'text' ? first.text : undefined
}
