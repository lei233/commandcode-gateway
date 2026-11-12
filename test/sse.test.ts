import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { ChatSseEncoder } from '../src/protocol/sse.ts'

import type { StreamChunk } from '../src/runtime.ts'

function parseFrames(frames: string[]): Array<Record<string, any>> {
  return frames.filter((f) => f !== 'data: [DONE]\n\n').map((f) => JSON.parse(f.slice('data: '.length)))
}

test('emits role, deltas, finish, and exactly one [DONE]', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
  const chunks: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: 'he' },
    { type: 'text-delta', index: 0, text: 'llo' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  for (const chunk of chunks) encoder.push(chunk)
  const { frames, outcome } = encoder.result()
  assert.equal(outcome.kind, 'success')

  const done = frames.filter((f) => f === 'data: [DONE]\n\n')
  assert.equal(done.length, 1)
  assert.equal(frames.at(-1), 'data: [DONE]\n\n')

  const docs = parseFrames(frames)
  // role first, then content deltas, then finish frame with empty delta
  assert.equal(docs[0]?.choices?.[0]?.delta?.role, 'assistant')
  assert.equal(docs[1]?.choices?.[0]?.delta?.content, 'he')
  assert.equal(docs[2]?.choices?.[0]?.delta?.content, 'llo')
  assert.equal(docs.at(-1)?.choices?.[0]?.finish_reason, 'stop')

  // id/created/model stable across frames
  for (const doc of docs) {
    assert.equal(doc.model, 'm1')
    assert.equal(doc.id, docs[0]?.id)
    assert.equal(doc.created, docs[0]?.created)
  }

  // every frame is a complete event with exactly one data line
  for (const frame of frames) {
    assert.ok(frame.endsWith('\n\n'))
    assert.equal(frame.split('\n').filter((l) => l.startsWith('data:')).length, 1)
  }
})

test('reassembled deltas reproduce full content', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
  for (const text of ['a', 'b', 'c']) encoder.push({ type: 'text-delta', index: 0, text })
  encoder.push({ type: 'finish', reason: { kind: 'stop' } })
  const { frames } = encoder.result()
  const text = parseFrames(frames)
    .map((d) => d.choices?.[0]?.delta?.content ?? '')
    .join('')
  assert.equal(text, 'abc')
})

test('tool deltas stream incrementally with stable indices', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
  encoder.push({ type: 'block-start', index: 3, blockType: 'tool-call' })
  encoder.push({ type: 'tool-call-delta', index: 3, id: 'call_1' as never, name: 'lookup', argumentsDelta: '{"q"' })
  encoder.push({ type: 'tool-call-delta', index: 3, id: 'call_1' as never, argumentsDelta: ':"x"}' })
  encoder.push({ type: 'block-end', index: 3, block: { type: 'tool-call', id: 'call_1' as never, name: 'lookup', arguments: '{"q":"x"}' } })
  encoder.push({ type: 'finish', reason: { kind: 'tool-calls' } })

  const { frames, outcome } = encoder.result()
  assert.equal(outcome.kind, 'success')
  assert.equal((outcome as { reason?: string }).reason, 'tool_calls')
  const docs = parseFrames(frames)
  const toolFrames = docs.filter((d) => d.choices?.[0]?.delta?.tool_calls)
  // header frame with index 0 + two argument deltas
  assert.equal(toolFrames[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.index, 0)
  assert.equal(toolFrames[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.id, 'call_1')
  assert.equal(toolFrames[1]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments, '{"q"')
  assert.equal(toolFrames[2]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments, ':"x"}')
})

test('two tools get consecutive chat indices', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
  for (const [index, id] of [[5, 'call_a'], [7, 'call_b']] as const) {
    encoder.push({ type: 'block-end', index, block: { type: 'tool-call', id: id as never, name: 't', arguments: '{}' } })
  }
  encoder.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  const { frames, outcome } = encoder.result()
  assert.equal(outcome.kind, 'success')
  const docs = parseFrames(frames)
  const indices = docs
    .flatMap((d) => d.choices?.[0]?.delta?.tool_calls ?? [])
    .map((t: { index: number }) => t.index)
  assert.deepEqual(indices, [0, 1])
})

test('include_usage emits a final empty-choices usage frame before [DONE]', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: true })
  encoder.push({ type: 'text-delta', index: 0, text: 'x' })
  encoder.push({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 } })
  encoder.push({ type: 'finish', reason: { kind: 'stop' } })
  const { frames } = encoder.result()
  const docs = parseFrames(frames)
  const usageFrame = docs.find((d) => d.usage !== undefined)
  assert.ok(usageFrame)
  assert.deepEqual(usageFrame.choices, [])
  // 缓存读命中以明细字段透出（cached_tokens）
  assert.deepEqual(usageFrame.usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
    prompt_tokens_details: { cached_tokens: 1 },
  })
  // 终序：usage 帧在 finish 帧之后、[DONE] 之前
  const usageIndex = docs.indexOf(usageFrame)
  const finishIndex = docs.findIndex((d) => d.choices?.[0]?.finish_reason === 'stop')
  assert.ok(usageIndex > finishIndex)
})

test('failed streams stop without [DONE]', () => {
  const cases: Array<{ name: string; chunks: StreamChunk[] }> = [
    { name: 'error finish', chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'X' } } }] },
    { name: 'no finish then explicit fail', chunks: [{ type: 'text-delta', index: 0, text: 'partial' }] },
    { name: 'malformed tool arguments', chunks: [
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_z' as never, name: 't', arguments: 'not-json' } },
    ] },
    { name: 'tool deltas disagree with block', chunks: [
      { type: 'tool-call-delta', index: 0, id: 'call_y' as never, name: 't', argumentsDelta: '{"a"' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_y' as never, name: 't', arguments: '{"b":1}' } },
    ] },
    { name: 'tool finish with unclosed tool', chunks: [
      { type: 'tool-call-delta', index: 0, id: 'call_w' as never, name: 't', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
  ]
  for (const { name, chunks } of cases) {
    const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
    for (const chunk of chunks) encoder.push(chunk)
    if (name === 'no finish then explicit fail') encoder.fail()
    const { frames, outcome } = encoder.result()
    assert.equal(outcome.kind, 'failure', name)
    assert.ok(!frames.some((f) => f === 'data: [DONE]\n\n'), name)
  }
})

test('drainNewFrames returns each frame exactly once', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
  encoder.push({ type: 'text-delta', index: 0, text: 'a' })
  const first = encoder.drainNewFrames()
  encoder.push({ type: 'text-delta', index: 0, text: 'b' })
  const second = encoder.drainNewFrames()
  const third = encoder.drainNewFrames()
  assert.equal(first.length, 2) // role + first delta
  assert.equal(second.length, 1)
  assert.equal(third.length, 0)
})

test('finish mapping covers length', () => {
  const encoder = new ChatSseEncoder({ model: 'm1', includeUsage: false })
  encoder.push({ type: 'text-delta', index: 0, text: 'x' })
  encoder.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  const { frames, outcome } = encoder.result()
  assert.equal(outcome.kind, 'success')
  assert.equal((outcome as { reason?: string }).reason, 'length')
  const docs = parseFrames(frames)
  assert.equal(docs.at(-1)?.choices?.[0]?.finish_reason, 'length')
})
