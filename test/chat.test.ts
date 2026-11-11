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

test('user and metadata are accepted silently as audit-only fields', () => {
  // 无行为承诺的附属字段：静默接受并丢弃，防止发送默认字段的客户端报错
  const accepted = convert({
    messages: [{ role: 'user', content: 'hi' }],
    user: 'user-1234',
    metadata: { session_id: 'sess-42' },
  })
  assert.equal(accepted.options.messages.length, 1)
  assert.equal('user' in accepted.options, false)
  assert.equal('metadata' in accepted.options, false)
})

test('reasoning_effort passes through verbatim; only type is validated', () => {
  // 注册表档位（含 max/xhigh/off）与任意字符串一律透传，由 adapter 按模型表过滤
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'off', 'minimal', 'none', 'ultra']) {
    const { options } = convert({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: effort })
    assert.equal(options.reasoningEffort, effort, effort)
  }
  // 非字符串仍拒绝
  expectInvalid({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 3 }, /reasoning_effort must be a non-empty string/)
  expectInvalid({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: '' }, /reasoning_effort must be a non-empty string/)
})

test('temperature passes through any finite number; only type is validated', () => {
  // 范围由上游判定（各模型区间不同，adapter 不做范围校验）
  for (const temperature of [0, 0.5, 1.5, 3, 100]) {
    const { options } = convert({ messages: [{ role: 'user', content: 'hi' }], temperature })
    assert.equal(options.temperature, temperature, String(temperature))
  }
  expectInvalid({ messages: [{ role: 'user', content: 'hi' }], temperature: 'hot' }, /temperature must be a finite number/)
})

test('overlong tool call ids pass through for adapter aliasing', () => {
  // 超长 id 由 adapter 重映射为短别名（跨 provider 会话迁移的正式能力）
  const longId = `call_${'x'.repeat(120)}`
  const { options } = convert({
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: longId, type: 'function', function: { name: 'one', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: longId, content: 'ok' },
    ],
  })
  const assistant = options.messages[1]
  assert.ok(assistant && assistant.role === 'assistant')
  const call = assistant.content.find((b) => b.type === 'tool-call')
  assert.ok(call && call.type === 'tool-call')
  assert.equal(call.id, longId, 'id preserved verbatim')
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

test('store:false is accepted as stateless default; store:true is rejected', () => {
  // OpenAI 生态客户端（Codex 等）默认发 store:false，必须放行
  const accepted = convert({ messages: [{ role: 'user', content: 'hi' }], store: false })
  assert.equal(accepted.options.messages.length, 1)
  expectInvalid({ messages: [{ role: 'user', content: 'hi' }], store: true }, /store:true is not supported/)
})

test('n>1, empty messages, and unknown roles are rejected', () => {
  expectInvalid({ n: 2, messages: [{ role: 'user', content: 'x' }] }, /single candidate/)
  expectInvalid({ messages: [] }, /must not be empty/)
  expectInvalid({ messages: [{ role: 'wizard', content: 'x' }] }, /unsupported role/)
})
