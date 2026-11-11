import { strict as assert } from 'node:assert'
import { connect as netConnect } from 'node:net'
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
  modelsCachePath: `/tmp/ccgw-shutdown-${process.pid}-${crypto.randomUUID()}.json`,
}

async function withServer(
  upstream: { fetchImpl: typeof fetch },
  configOverrides: Partial<GatewayConfig> = {},
  run: (base: string) => Promise<void>,
): Promise<void> {
  const gateway = await startGateway({
    config: { ...BASE_CONFIG, ...configOverrides },
    adapter: { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: `/tmp/ccgw-sd-${crypto.randomUUID()}.json`, fetchImpl: upstream.fetchImpl },
  })
  try {
    await run(`http://127.0.0.1:${gateway.address.port}`)
  } finally {
    await gateway.close(500)
  }
}

function chatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  })
}

const AUTH = { authorization: 'Bearer user_test-key', 'content-type': 'application/json' }

test('two-round tool closure over the server keeps ids', async () => {
  // 上游按 history 有无 role:tool 区分两轮
  const upstream = {
    fetchImpl: (async (input: unknown, init?: { body?: string } | undefined) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      const body = String(init?.body ?? '{}')
      const round2 = body.includes('"tool"')
      const encoder = new TextEncoder()
      const events = round2
        ? [{ type: 'text-delta', text: 'probe-result-42' }, { type: 'finish', finishReason: 'stop' }]
        : [
          { type: 'tool-call', toolCallId: 'call_srv_1', toolName: 'lookup', input: { q: 'x' } },
          { type: 'finish', finishReason: 'tool_calls' },
        ]
      const stream = (async function* () {
        for (const event of events) yield encoder.encode(`${JSON.stringify(event)}\n`)
      })()
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  }
  await withServer(upstream, {}, async (base) => {
    // 第一轮：拿到工具调用
    const round1 = await (await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: AUTH, body: chatBody(),
    })).json() as { choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }
    const call = round1.choices[0]?.message.tool_calls?.[0]
    assert.ok(call)
    assert.equal(call.id, 'call_srv_1')

    // 第二轮：assistant tool_calls + tool 回填
    const round2 = await (await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: AUTH, body: chatBody({
        messages: [
          { role: 'user', content: 'run' },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: 'probe-result-42 data' },
          { role: 'user', content: 'summarize' },
        ],
      }),
    })).json() as { choices: Array<{ message: { content: string } }> }
    assert.equal(round2.choices[0]?.message.content, 'probe-result-42')
  })
})

test('SSE emits keepalive comment when upstream delivers silent events', async () => {
  const upstream = {
    fetchImpl: (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      const encoder = new TextEncoder()
      const events = [
        { type: 'reasoning-start' },                       // 静默事件：开流前
        { type: 'text-delta', text: 'x' },                 // 首个可见输出 → 开流
        { type: 'cache-write-tokens', cacheWriteTokens: 5 }, // 静默事件：开流后 → 心跳
        { type: 'text-delta', text: 'y' },
        { type: 'finish', finishReason: 'stop' },
      ]
      const stream = (async function* () {
        for (const event of events) yield encoder.encode(`${JSON.stringify(event)}\n`)
      })()
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  }
  await withServer(upstream, {}, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: AUTH, body: chatBody({ stream: true }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(text.includes(': keepalive'), 'comment keepalive frame present')
    // 心跳不破坏正常终序
    const frames = text.split('\n\n').filter(Boolean).filter((f) => f.startsWith('data: '))
    assert.equal(frames.at(-1), 'data: [DONE]')
  })
})

test('SSE mid-stream upstream failure sends error frame and closes without [DONE]', async () => {
  const upstream = {
    fetchImpl: (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      // 先一帧可见输出（开流），然后流断掉（无 finish）
      const encoder = new TextEncoder()
      const stream = (async function* () {
        yield encoder.encode(`${JSON.stringify({ type: 'text-delta', text: 'partial' })}\n`)
      })()
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  }
  await withServer(upstream, {}, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: AUTH, body: chatBody({ stream: true }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(text.includes('"error"'), 'error frame present')
    assert.ok(!text.includes('[DONE]'), 'no [DONE] on failed stream')
  })
})

test('backpressure pauses upstream reads until the client drains', async () => {
  const pulls: number[] = []
  const upstream = {
    fetchImpl: (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      const encoder = new TextEncoder()
      const big = 'z'.repeat(4096)
      const events = [
        { type: 'text-delta', text: big },
        { type: 'text-delta', text: big },
        { type: 'text-delta', text: big },
        { type: 'text-delta', text: big },
        { type: 'finish', finishReason: 'stop' },
      ]
      const { ReadableStream } = await import('node:stream/web')
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls.push(pulls.length)
          const event = events[pulls.length - 1]
          if (event === undefined) controller.close()
          else controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  }
  const gateway = await startGateway({
    config: { ...BASE_CONFIG },
    adapter: { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: `/tmp/ccgw-bp-${crypto.randomUUID()}.json`, fetchImpl: upstream.fetchImpl },
  })
  const port = gateway.address.port
  // raw socket 手写 HTTP（http.request 自动排水产生不了真背压）
  const socket = netConnect(port, '127.0.0.1')
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer user_test-key\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(chatBody({ stream: true }))}\r\n\r\n${chatBody({ stream: true })}`)
  await new Promise((r) => setTimeout(r, 150))
  const firstSample = pulls.length
  socket.pause()
  await new Promise((r) => setTimeout(r, 200))
  const secondSample = pulls.length
  socket.resume()
  socket.destroy()
  await gateway.close(500)
  // 暂停期间上游读取基本停滞（允许少量在途）
  assert.ok(secondSample - firstSample < 3, `upstream reads paused under backpressure (${firstSample} → ${secondSample})`)
})

test('graceful shutdown waits for in-flight and aborts after grace', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((r) => { release = r })
  let upstreamAborted = false
  const upstream = {
    fetchImpl: (async (input: unknown, init?: { signal?: AbortSignal } | undefined) => {
      const url = String(input)
      if (url.endsWith('/provider/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', name: 'M', context_length: 64000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) return new Response('{}', { status: 200 })
      init?.signal?.addEventListener('abort', () => { upstreamAborted = true })
      await gate
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  }
  const gateway = await startGateway({
    config: { ...BASE_CONFIG },
    adapter: { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: `/tmp/ccgw-gs-${crypto.randomUUID()}.json`, fetchImpl: upstream.fetchImpl },
  })
  const base = `http://127.0.0.1:${gateway.address.port}`
  const inFlight = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: AUTH, body: chatBody() }).catch(() => undefined)
  await new Promise((r) => setTimeout(r, 150))

  const closing = gateway.close(200)
  await new Promise((r) => setTimeout(r, 50))
  const outcome = await closing
  assert.equal(outcome, 'forced', 'shutdown aborts lingering requests after grace')
  assert.equal(upstreamAborted, true, 'shutdown abort propagates to upstream')
  release?.()
  await inFlight
})

test('concurrent requests stay isolated by credential', async () => {
  const upstream = createRecordingUpstream([
    { type: 'text-delta', text: 'shared-mock' },
    { type: 'finish', finishReason: 'stop' },
  ])
  await withServer(upstream, {}, async (base) => {
    const results = await Promise.all(['user_a', 'user_b'].map((key) =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: chatBody(),
      }).then((r) => r.json() as Promise<{ choices: Array<{ message: { content: string } }> }>),
    ))
    for (const result of results) {
      assert.equal(result.choices[0]?.message.content, 'shared-mock')
    }
    // 两个请求都带了各自的 key
    const generateCalls = upstream.collectUpstreamCalls().filter((c) => c.url.endsWith('/alpha/generate'))
    assert.equal(generateCalls.length, 2)
  })
})
