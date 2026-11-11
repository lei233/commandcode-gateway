import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { chatToGenerateOptions, isChatRequestError, toolResultText } from '../src/protocol/chat.ts'

import type { RequestMessage } from '../src/runtime.ts'

const MODEL = 'claude-sonnet-4-6'

function convert(body: unknown): ReturnType<typeof chatToGenerateOptions> {
  const result = chatToGenerateOptions(body, MODEL)
  return result
}

function expectInvalid(body: unknown, pattern: RegExp): void {
  try {
    chatToGenerateOptions(body, MODEL)
    assert.fail('expected a 400-shaped throw')
  } catch (error) {
    assert.ok(isChatRequestError(error), `expected ChatRequestError, got ${String(error)}`)
    assert.match(error.message, pattern)
  }
}

test('converts a plain user message', () => {
  const { options, imageDataUrls } = convert({ messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(imageDataUrls.length, 0)
  assert.equal(options.model, MODEL)
  assert.equal(options.provider, 'commandcode')
  assert.equal(options.messages.length, 1)
  const message = options.messages[0]
  if (message && message.role === 'user') {
    assert.equal(message.content.length, 1)
    assert.deepEqual(message.content[0], { type: 'text', text: 'hello' })
  } else {
    assert.fail('expected a user message')
  }
})

test('merges system and developer texts in order', () => {
  const { options } = convert({
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'developer', content: 'extra rules' },
    ],
  })
  assert.equal(options.system, 'be brief\nextra rules')
})

test('assistant reasoning_content becomes a reasoning block', () => {
  const { options } = convert({
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', reasoning_content: 'thinking...' },
    ],
  })
  const assistant = options.messages.at(-1)
  if (assistant && assistant.role === 'assistant') {
    assert.equal(assistant.content[0]?.type, 'reasoning')
    assert.equal(assistant.content[1]?.type, 'text')
  } else {
    assert.fail('expected an assistant message')
  }
})

test('tool calls keep ids and backfill out of order within a batch', () => {
  const { options } = convert({
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_p1', type: 'function', function: { name: 'one', arguments: '{"a":1}' } },
          { id: 'call_p2', type: 'function', function: { name: 'two', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_p2', content: 'second' },
      { role: 'tool', tool_call_id: 'call_p1', content: 'first' },
      { role: 'user', content: 'done' },
    ],
  })
  assert.deepEqual(options.messages.map((m: RequestMessage) => m.role), ['user', 'assistant', 'tool', 'tool', 'user'])
  assert.equal(toolResultText(options.messages[2]!), 'second')
  assert.equal(toolResultText(options.messages[3]!), 'first')
})

test('unresolved batch before a normal message is rejected', () => {
  expectInvalid({
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'one', arguments: '{}' } }],
      },
      { role: 'user', content: 'too early' },
    ],
  }, /backfilled first/)
})

test('duplicate tool call ids are rejected', () => {
  expectInvalid({
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_dupe', type: 'function', function: { name: 'one', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_dupe', content: 'ok' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_dupe', type: 'function', function: { name: 'one', arguments: '{}' } }],
      },
    ],
  }, /duplicate tool call id/)
})

test('open batch at end of request is rejected', () => {
  expectInvalid({
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_open', type: 'function', function: { name: 'one', arguments: '{}' } }],
      },
    ],
  }, /without results/)
})

test('tool result with unknown tool_call_id is rejected', () => {
  expectInvalid({
    messages: [
      { role: 'user', content: 'run' },
      { role: 'tool', tool_call_id: 'call_ghost', content: 'x' },
    ],
  }, /does not match an unresolved tool call/)
})

test('tool_choice none drops declarations but keeps history', () => {
  const withTools = {
    tools: [{ type: 'function', function: { name: 'one', description: '', parameters: { type: 'object' } } }],
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'one', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'again' },
    ],
  }
  const auto = convert({ ...withTools, tool_choice: 'auto' })
  assert.ok(auto.options.tools !== undefined)
  const none = convert({ ...withTools, tool_choice: 'none' })
  assert.equal(none.options.tools, undefined)
  // history calls and results are preserved
  assert.equal(none.options.messages.filter((m: RequestMessage) => m.role === 'tool').length, 1)
})

test('forced tool_choice is rejected', () => {
  expectInvalid({
    tool_choice: { type: 'function', function: { name: 'one' } },
    messages: [{ role: 'user', content: 'hi' }],
  }, /forced tool_choice/)
})

test('maps sampling parameters onto GenerateOptions fields', () => {
  const { options } = convert({
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    max_tokens: 512,
    reasoning_effort: 'low',
  })
  assert.equal(options.temperature, 0.5)
  assert.equal(options.maxTokens, 512)
  assert.equal(options.reasoningEffort, 'low')
})

test('max_completion_tokens wins over max_tokens', () => {
  const { options } = convert({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 10,
    max_completion_tokens: 20,
  })
  assert.equal(options.maxTokens, 20)
})

test('unsupported generation parameters are rejected explicitly', () => {
  for (const param of ['top_p', 'presence_penalty', 'seed', 'response_format', 'parallel_tool_calls', 'stop']) {
    expectInvalid({
      messages: [{ role: 'user', content: 'hi' }],
      [param]: param === 'top_p' ? 1 : param === 'response_format' ? { type: 'text' } : param === 'parallel_tool_calls' ? true : 'x',
    }, new RegExp(`${param} is not supported`))
  }
})

test('invalid temperature and effort values are rejected', () => {
  expectInvalid({ messages: [{ role: 'user', content: 'hi' }], temperature: 3 }, /temperature/)
  expectInvalid({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'ultra' }, /reasoning_effort/)
})

test('image_url data URLs are collected in order; HTTP(S) links are rejected', () => {
  const dataUrlA = 'data:image/png;base64,AAAA'
  const dataUrlB = 'data:image/jpeg;base64,BBBB'
  const { imageDataUrls } = convert({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look:' },
        { type: 'image_url', image_url: { url: dataUrlA } },
        { type: 'text', text: 'and:' },
        { type: 'image_url', image_url: { url: dataUrlB, detail: 'low' } },
      ],
    }],
  })
  assert.deepEqual(imageDataUrls, [dataUrlA, dataUrlB])

  expectInvalid({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
    }],
  }, /HTTP\(S\) image URLs are not supported/)
})

test('image parts are only accepted in user messages', () => {
  expectInvalid({
    messages: [
      { role: 'system', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ],
  }, /not supported/)
})

test('n>1, empty messages, and unknown roles are rejected', () => {
  expectInvalid({ n: 2, messages: [{ role: 'user', content: 'x' }] }, /single candidate/)
  expectInvalid({ messages: [] }, /must not be empty/)
  expectInvalid({ messages: [{ role: 'wizard', content: 'x' }] }, /unsupported role/)
})
