import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { aggregateToChatJson } from '../src/protocol/complete.ts'
import { StreamFailure } from '../src/protocol/output.ts'
import { LlmError } from '../src/runtime.ts'

import type { StreamChunk } from '../src/runtime.ts'

async function* streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

function textStream(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('aggregates a text stream into one chat completion', async () => {
  const result = await aggregateToChatJson(streamOf(textStream('hello there')), { model: 'm1' })
  assert.equal(result.object, 'chat.completion')
  assert.equal(result.model, 'm1')
  assert.equal(result.choices[0]?.message.content, 'hello there')
  assert.equal(result.choices[0]?.finish_reason, 'stop')
  assert.match(result.id, /^chatcmpl-/)
})

test('separates reasoning from content', async () => {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const result = await aggregateToChatJson(streamOf(chunks), { model: 'm1' })
  assert.equal(result.choices[0]?.message.content, 'answer')
  assert.equal(result.choices[0]?.message.reasoning_content, 'think')
})

test('aggregates tool calls and maps finish reason', async () => {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a' as never, name: 'lookup', arguments: '{"q":"x"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const result = await aggregateToChatJson(streamOf(chunks), { model: 'm1' })
  assert.equal(result.choices[0]?.finish_reason, 'tool_calls')
  assert.equal(result.choices[0]?.message.content, null)
  assert.deepEqual(result.choices[0]?.message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
  ])
})

test('maps max-tokens finish to length', async () => {
  const chunks: StreamChunk[] = [
    ...textStream('partial'),
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const result = await aggregateToChatJson(streamOf(chunks), { model: 'm1' })
  assert.equal(result.choices[0]?.finish_reason, 'length')
})

test('usage counts cache read/write into prompt tokens', async () => {
  const chunks: StreamChunk[] = [
    ...textStream('hi'),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 } },
  ]
  const result = await aggregateToChatJson(streamOf(chunks), { model: 'm1' })
  assert.deepEqual(result.usage, { prompt_tokens: 160, completion_tokens: 5, total_tokens: 165 })
})

test('error finish reason fails with 502', async () => {
  const chunks: StreamChunk[] = [
    { type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'BOOM' } } },
  ]
  await assert.rejects(
    aggregateToChatJson(streamOf(chunks), { model: 'm1' }),
    (error: unknown) => error instanceof StreamFailure && error.status === 502 && error.code === 'upstream_error',
  )
})

test('missing successful finish fails as terminated early', async () => {
  const chunks: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: 'partial' },
  ]
  await assert.rejects(
    aggregateToChatJson(streamOf(chunks), { model: 'm1' }),
    (error: unknown) => error instanceof StreamFailure && error.code === 'stream_terminated_early',
  )
})

test('tool_calls finish without surviving calls fails', async () => {
  const chunks: StreamChunk[] = [
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  await assert.rejects(
    aggregateToChatJson(streamOf(chunks), { model: 'm1' }),
    (error: unknown) => error instanceof StreamFailure && error.code === 'incomplete_tool_calls',
  )
})

test('LlmError with status passes through unchanged', async () => {
  async function* failing(): AsyncIterable<StreamChunk> {
    throw new LlmError('denied', 'AUTH', { status: 401 })
  }
  await assert.rejects(
    aggregateToChatJson(failing(), { model: 'm1' }),
    (error: unknown) => error instanceof LlmError,
  )
})

test('symbolic deadline abort maps to 504 StreamFailure', async () => {
  async function* aborted(): AsyncIterable<StreamChunk> {
    throw 'deadline'
  }
  await assert.rejects(
    aggregateToChatJson(aborted(), { model: 'm1' }),
    (error: unknown) => error instanceof StreamFailure && error.status === 504 && error.code === 'upstream_timeout',
  )
})

test('aggregated output over the byte cap fails', async () => {
  const chunks: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: 'x'.repeat(64) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await assert.rejects(
    aggregateToChatJson(streamOf(chunks), { model: 'm1', maxBytes: 16 }),
    (error: unknown) => error instanceof StreamFailure && error.code === 'output_too_large',
  )
})
