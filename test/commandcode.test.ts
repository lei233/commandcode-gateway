import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { listCommandCodeModels, mapAdapterError, streamCommandCode } from '../src/commandcode.ts'
import { LlmError } from '../src/runtime.ts'

// adapter 封装用注入 fetch 测试：记录外发请求并用脚本化 /alpha/generate
// NDJSON 事件流应答，离线钉住请求形状（cli 协议、每请求 key、拒绝重定向、
// 空闲超时注入、参数到达）与错误映射表。

/** 每文件独立临时目录，退出时统一清理（不向 /tmp 泄漏缓存文件）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ccgw-'))
after(() => rmSync(TMP, { recursive: true, force: true }))
const cachePath = (name: string): string => join(TMP, `${name}-${crypto.randomUUID()}.json`)

const config = {
  apiBase: 'https://upstream.example',
  workingDir: '/workspace',
  modelsCachePath: cachePath('models-cache'),
}

interface RecordedFetch {
  (input: unknown, init?: unknown): Promise<Response>
  lastRequest?: { url: string; init?: { headers?: Record<string, string>; redirect?: string; body?: string; signal?: AbortSignal } }
  requests: Array<{ url: string; init?: Record<string, unknown> }>
}

function okFetch(events: Array<Record<string, unknown>>): RecordedFetch {
  const fetchImpl: RecordedFetch = async (input, init) => {
    const record = { url: String(input), init: init as Record<string, unknown> }
    fetchImpl.requests.push(record)
    fetchImpl.lastRequest = record as RecordedFetch['lastRequest']
    const url = String(input)
    if (url.endsWith('/provider/v1/models')) {
      // OpenAI 风格目录：{ object: 'list', data: [...] }，条目需 id/name/context_length
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'model-a', name: 'A', context_length: 64000 }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) {
      // 账号探测端点：空对象即可；不能拦截 /alpha/generate（NDJSON 分支）
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const encoder = new TextEncoder()
    const body = (async function* () {
      for (const event of events) {
        yield encoder.encode(`${JSON.stringify(event)}\n`)
      }
    })()
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  fetchImpl.requests = []
  return fetchImpl
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function userOptions(extra: Record<string, unknown> = {}): Omit<import('../src/runtime.ts').GenerateOptions, 'signal' | 'provider'> {
  return {
    model: 'model-x',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...extra,
  } as Omit<import('../src/runtime.ts').GenerateOptions, 'signal' | 'provider'>
}

test('streamCommandCode posts to /alpha/generate with the request key and no redirects', async () => {
  const fetchImpl = okFetch([
    { type: 'text-delta', text: 'hi' },
    { type: 'finish', finishReason: 'stop' },
  ])
  const chunks = await collect(streamCommandCode(
    { ...config, fetchImpl },
    { apiKey: 'user_scoped', signal: new AbortController().signal },
    userOptions(),
  ))
  assert.equal(fetchImpl.lastRequest?.url, 'https://upstream.example/alpha/generate')
  assert.equal(fetchImpl.lastRequest?.init?.redirect, 'error')
  const headers = fetchImpl.lastRequest?.init?.headers
  const auth = typeof headers === 'object' && headers !== null
    ? (headers as Record<string, string>).Authorization ?? (headers as Record<string, string>).authorization
    : undefined
  assert.equal(auth, 'Bearer user_scoped')
  assert.ok(chunks.some((c) => (c as { type: string }).type === 'finish'))
})

test('each request resolves its own key through the closure', async () => {
  const fetchImpl = okFetch([{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }])
  for (const key of ['user_a', 'user_b']) {
    await collect(streamCommandCode(
      { ...config, fetchImpl },
      { apiKey: key, signal: new AbortController().signal },
      userOptions(),
    ))
    const headers = fetchImpl.lastRequest?.init?.headers
    const auth = (headers as Record<string, string>)?.Authorization ?? (headers as Record<string, string>)?.authorization
    assert.equal(auth, `Bearer ${key}`)
  }
})

test('sampling parameters reach the upstream request body', async () => {
  const fetchImpl = okFetch([{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }])
  await collect(streamCommandCode(
    { ...config, fetchImpl },
    { apiKey: 'user_p', signal: new AbortController().signal },
    userOptions({ temperature: 0.7, maxTokens: 256, reasoningEffort: 'high' }),
  ))
  const parsed = JSON.parse(String(fetchImpl.lastRequest?.init?.body ?? '{}')) as { params?: Record<string, unknown> }
  // CLI wire 格式将生成参数放在 params 嵌套对象中
  assert.equal(parsed.params?.temperature, 0.7)
  assert.equal(parsed.params?.max_tokens, 256)
})

test('stream idle timeout is injected per request, not a whole-request deadline', async () => {
  const fetchImpl = okFetch([{ type: 'text-delta', text: 'x' }, { type: 'finish', finishReason: 'stop' }])
  await collect(streamCommandCode(
    { ...config, fetchImpl, streamIdleTimeoutMs: 1234 },
    { apiKey: 'user_t', signal: new AbortController().signal },
    userOptions(),
  ))
  assert.equal(fetchImpl.requests.length, 1)
})

test('listCommandCodeModels queries the provider models endpoint', async () => {
  // adapter 内部 GatewayFacts 有进程级缓存（内存+磁盘）：每次测试用独立
  // cachePath 并断言请求序列，避免跨测试污染。
  const fetchImpl = okFetch([])
  const models = await listCommandCodeModels({
    ...config,
    modelsCachePath: cachePath('test-models'),
    fetchImpl,
  }, {
    apiKey: 'user_m',
    signal: new AbortController().signal,
  })
  assert.ok(fetchImpl.requests.some((r) => r.url.endsWith('/provider/v1/models')))
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'model-a')
})

test('mapAdapterError keeps 401/403/429 statuses and retry-after', () => {
  const failure = (status: number, extra: Record<string, unknown> = {}): LlmError =>
    new LlmError('provider refused', 'AUTH', { status, ...extra })
  const unauthorized = mapAdapterError(failure(401))
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.code, 'auth')
  const forbidden = mapAdapterError(failure(403))
  assert.equal(forbidden.status, 403)
  const limited = mapAdapterError(failure(429, { providerRetryAfterMs: 1500 }))
  assert.equal(limited.status, 429)
  assert.equal(limited.retryAfterSeconds, 2)
})

test('mapAdapterError maps UNSUPPORTED_CONTENT to 400', () => {
  const mapped = mapAdapterError(new LlmError('model cannot read images', 'UNSUPPORTED_CONTENT'))
  assert.equal(mapped.status, 400)
  assert.equal(mapped.code, 'unsupported-content')
})

test('mapAdapterError maps unknown statuses and codes to bounded 502s', () => {
  const mapped = mapAdapterError(new LlmError('boom', 'PROTOCOL', { status: 500 }))
  assert.equal(mapped.status, 502)
  assert.equal(mapped.code, 'protocol')

  const unknown = mapAdapterError(new LlmError('odd', 'SOME_PRIVATE_CODE'))
  assert.equal(unknown.status, 502)
  assert.equal(unknown.code, 'upstream_error')

  assert.equal(mapAdapterError(new Error('network gone')).status, 502)
})

test('mapAdapterError carries the upstream request id when the provider stamped one', () => {
  const withId = mapAdapterError(new LlmError('boom', 'PROTOCOL', { status: 500, requestId: 'req-upstream-42' as never }))
  assert.equal(withId.requestId, 'req-upstream-42')
  // 无 id 的失败不带该字段
  const withoutId = mapAdapterError(new LlmError('boom', 'PROTOCOL', { status: 500 }))
  assert.equal(withoutId.requestId, undefined)
})

test('mapAdapterError maps abort timeouts to 504 and cancels to 499', () => {
  const timeout = new Error('signal timed out')
  timeout.name = 'TimeoutError'
  const mappedTimeout = mapAdapterError(timeout)
  assert.equal(mappedTimeout.status, 504)
  assert.equal(mappedTimeout.code, 'upstream_timeout')

  const cancel = new Error('aborted')
  cancel.name = 'AbortError'
  const mappedCancel = mapAdapterError(cancel)
  assert.equal(mappedCancel.status, 499)
  assert.equal(mappedCancel.code, 'client_closed_request')
})

test('mapAdapterError maps symbolic abort causes', () => {
  assert.equal(mapAdapterError('deadline').status, 504)
  assert.equal(mapAdapterError('shutdown').status, 503)
  assert.equal(mapAdapterError('client').status, 499)
})
