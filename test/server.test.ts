import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { startGateway } from '../src/server.ts'
import type { GatewayConfig } from '../src/config.ts'
import { createRecordingUpstream } from './helpers/upstream-mock.ts'

const BASE_CONFIG: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  maxBodyBytes: 1024 * 1024,
  streamIdleTimeoutMs: 5_000,
  nonStreamIdleTimeoutMs: 5_000,
  maxInflight: 0,
  clientDrainTimeoutMs: 0,
  keepAliveTimeoutMs: 65_000,
  useProviderModels: true,
  modelRefreshIntervalMs: 300_000,
  apiBase: 'https://upstream.example',
  workingDir: '/workspace',
  modelsCachePath: `/tmp/ccgw-server-test-${process.pid}-${crypto.randomUUID()}.json`,
}

async function withServer(
  events: Array<Record<string, unknown>>,
  configOverrides: Partial<GatewayConfig> = {},
  run: (base: string, upstream: ReturnType<typeof createRecordingUpstream>) => Promise<void>,
): Promise<void> {
  const upstream = createRecordingUpstream(events)
  const gateway = await startGateway({
    config: { ...BASE_CONFIG, ...configOverrides },
    adapter: {
      apiBase: 'https://upstream.example',
      workingDir: '/workspace',
      modelsCachePath: BASE_CONFIG.modelsCachePath,
      fetchImpl: upstream.fetchImpl,
    },
  })
  try {
    await run(`http://127.0.0.1:${gateway.address.port}`, upstream)
  } finally {
    await gateway.close(1_000)
  }
}

function chatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  })
}

const AUTH = { authorization: 'Bearer user_test-key' }

test('health endpoint answers 200 without auth and without inflight', async () => {
  await withServer([{ type: 'text-delta', text: 'x' }, { type: 'finish', finishReason: 'stop' }], {}, async (base, upstream) => {
    const response = await fetch(`${base}/health`)
    assert.equal(response.status, 200)
    assert.equal(upstream.collectUpstreamCalls().length, 0)
  })
})

test('unknown routes return 404', async () => {
  await withServer([], {}, async (base) => {
    const response = await fetch(`${base}/v1/embeddings`)
    assert.equal(response.status, 404)
    const body = await response.json() as { error: { message: string } }
    assert.match(body.error.message, /unknown route/)
  })
})

test('missing credentials return 401; conflicting headers return 400', async () => {
  await withServer([], {}, async (base, upstream) => {
    const missing = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody(),
    })
    assert.equal(missing.status, 401)

    const conflict = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_a', 'x-api-key': 'user_b' },
      body: chatBody(),
    })
    assert.equal(conflict.status, 400)
    assert.equal(upstream.collectUpstreamCalls().length, 0, 'no upstream calls for rejected requests')
  })
})

test('non-stream JSON round trip with usage', async () => {
  await withServer([
    { type: 'text-delta', text: 'hi there' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2 } },
  ], {}, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: chatBody(),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as {
      object: string
      choices: Array<{ message: { content: string }; finish_reason: string }>
      usage?: { prompt_tokens: number }
    }
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0]?.message.content, 'hi there')
    assert.equal(body.choices[0]?.finish_reason, 'stop')
    assert.equal(body.usage?.prompt_tokens, 3)
  })
})

test('stream SSE emits role, deltas, finish, exactly one [DONE]', async () => {
  await withServer([
    { type: 'text-delta', text: 'he' },
    { type: 'text-delta', text: 'llo' },
    { type: 'finish', finishReason: 'stop' },
  ], {}, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: chatBody({ stream: true }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    // 注释心跳行（: keepalive）不是 data 帧，过滤后再解析
    const frames = text.split('\n\n').filter(Boolean).filter((f) => f.startsWith('data: '))
    const doneCount = frames.filter((f) => f === 'data: [DONE]').length
    assert.equal(doneCount, 1)
    assert.equal(frames.at(-1), 'data: [DONE]')
    const docs = frames.filter((f) => f !== 'data: [DONE]').map((f) => JSON.parse(f.slice('data: '.length)))
    assert.equal(docs[0]?.choices?.[0]?.delta?.role, 'assistant')
    const content = docs.map((d: { choices?: Array<{ delta?: { content?: string } }> }) => d.choices?.[0]?.delta?.content ?? '').join('')
    assert.equal(content, 'hello')
    const finishes = docs.map((d: { choices?: Array<{ finish_reason?: string }> }) => d.choices?.[0]?.finish_reason).filter(Boolean)
    assert.deepEqual(finishes, ['stop'])
    for (const doc of docs) {
      assert.equal(doc.model, 'mock-model')
      assert.equal(doc.id, docs[0].id)
    }
  })
})

test('stream include_usage appends usage frame before [DONE]', async () => {
  await withServer([
    { type: 'text-delta', text: 'x' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 7, outputTokens: 3 } },
  ], {}, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: chatBody({ stream: true, stream_options: { include_usage: true } }),
    })
    const text = await response.text()
    const frames = text.split('\n\n').filter(Boolean).filter((f) => f.startsWith('data: '))
    const docs = frames.filter((f) => f !== 'data: [DONE]').map((f) => JSON.parse(f.slice('data: '.length)))
    const usageFrame = docs.find((d: { usage?: unknown }) => d.usage !== undefined)
    assert.ok(usageFrame, 'usage frame present')
    assert.deepEqual(usageFrame.choices, [])
    assert.equal(usageFrame.usage.prompt_tokens, 7)
    // [DONE] 在最后
    assert.equal(frames.at(-1), 'data: [DONE]')
  })
})

test('upstream 401 maps to JSON 401 with Retry-After absent', async () => {
  // 用拒绝 key 的上游：/alpha/generate 返回 401
  const upstream = {
    fetchImpl: (async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    collectUpstreamCalls: () => [] as Array<{ url: string }>,
  }
  const gateway = await startGateway({
    config: { ...BASE_CONFIG },
    adapter: { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: `/tmp/ccgw-401-${crypto.randomUUID()}.json`, fetchImpl: upstream.fetchImpl },
  })
  try {
    const base = `http://127.0.0.1:${gateway.address.port}`
    const json = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: chatBody(),
    })
    assert.equal(json.status, 401)
    const body = await json.json() as { error: { type: string } }
    assert.equal(body.error.type, 'authentication_error')

    // 流式开流前错误同样是 JSON 401
    const sse = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: chatBody({ stream: true }),
    })
    assert.equal(sse.status, 401)
    assert.match(sse.headers.get('content-type') ?? '', /application\/json/)
    const sseBody = await sse.json() as { error: { type: string } }
    assert.equal(sseBody.error.type, 'authentication_error')
  } finally {
    await gateway.close(1_000)
  }
})

test('invalid body rejected with 400 before upstream calls', async () => {
  await withServer([], {}, async (base, upstream) => {
    const noModel = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ messages: [] }),
    })
    assert.equal(noModel.status, 400)
    const badTool = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: chatBody({ tool_choice: { type: 'function', function: { name: 'x' } } }),
    })
    assert.equal(badTool.status, 400)
    assert.equal(upstream.collectUpstreamCalls().filter((c) => c.url.endsWith('/alpha/generate')).length, 0)
  })
})

test('body over limit returns 413', async () => {
  await withServer([], { maxBodyBytes: 64 }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: chatBody() + ' '.repeat(200),
    })
    assert.equal(response.status, 413)
  })
})

test('max inflight returns 503 with Retry-After', async () => {
  // 挂起上游：第一次请求占住在途名额
  let hangingRelease: (() => void) | undefined
  const release = new Promise<void>((resolveRelease) => {
    hangingRelease = resolveRelease
  })
  const events = [{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }]
  const upstream = {
    fetchImpl: (async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      await release
      const encoder = new TextEncoder()
      const body = (async function* () {
        for (const event of events) yield encoder.encode(JSON.stringify(event) + '\n')
      })()
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  }
  const gateway = await startGateway({
    config: { ...BASE_CONFIG, maxInflight: 1 },
    adapter: { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: `/tmp/ccgw-inflight-${crypto.randomUUID()}.json`, fetchImpl: upstream.fetchImpl },
  })
  try {
    const base = `http://127.0.0.1:${gateway.address.port}`
    const first = fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: chatBody(),
    })
    // 等第一个请求真正进入在途
    await new Promise((r) => setTimeout(r, 150))
    const second = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: chatBody(),
    })
    assert.equal(second.status, 503)
    assert.ok(second.headers.get('retry-after'))
    hangingRelease?.()
    const firstResponse = await first
    assert.equal(firstResponse.status, 200)
  } finally {
    hangingRelease?.()
    await gateway.close(1_000)
  }
})

test('client disconnect propagates cancellation to upstream', async () => {
  let upstreamAborted = false
  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const upstream = {
    fetchImpl: (async (input: unknown, init?: { signal?: AbortSignal } | undefined) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      init?.signal?.addEventListener('abort', () => { upstreamAborted = true })
      await gate.catch(() => undefined)
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  }
  const gateway = await startGateway({
    config: { ...BASE_CONFIG },
    adapter: { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: `/tmp/ccgw-cancel-${crypto.randomUUID()}.json`, fetchImpl: upstream.fetchImpl },
  })
  try {
    const base = `http://127.0.0.1:${gateway.address.port}`
    const controller = new AbortController()
    const request = fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: chatBody(),
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 200))
    controller.abort()
    await request.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(upstreamAborted, true)
  } finally {
    releaseGate?.()
    await gateway.close(1_000)
  }
})
