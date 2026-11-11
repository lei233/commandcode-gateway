import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { FALLBACK_MODEL_IDS, resetModelCache, resolveModelCatalog } from '../src/models.ts'
import type { GatewayConfig } from '../src/config.ts'
import { createRecordingUpstream } from './helpers/upstream-mock.ts'

/** 每文件独立临时目录，退出时统一清理（不向 /tmp 泄漏缓存文件）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ccgw-'))
after(() => rmSync(TMP, { recursive: true, force: true }))
const cachePath = (name: string): string => join(TMP, `${name}-${crypto.randomUUID()}.json`)

const CONFIG: GatewayConfig = {
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
  modelsCachePath: cachePath('models'),
}

function adapterWith(fetchImpl: typeof fetch): Parameters<typeof resolveModelCatalog>[1] {
  return { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: cachePath('ad'), fetchImpl }
}

test('dynamic discovery refreshes the global cache and serves later requests from it', async () => {
  resetModelCache()
  const upstream = createRecordingUpstream([])
  const adapter = adapterWith(upstream.fetchImpl)
  const first = await resolveModelCatalog(CONFIG, adapter, 'user_m', AbortSignal.timeout(5_000))
  assert.deepEqual(first, ['mock-model'])

  // 第二次：TTL 内直接命中缓存，不再发上游请求
  const before = upstream.collectUpstreamCalls().length
  const second = await resolveModelCatalog(CONFIG, adapter, 'user_other', AbortSignal.timeout(5_000))
  assert.deepEqual(second, ['mock-model'])
  assert.equal(upstream.collectUpstreamCalls().length, before, 'cache hit performs no upstream call')
})

test('expired cache triggers a refresh', async () => {
  resetModelCache()
  const upstream = createRecordingUpstream([])
  const adapter = adapterWith(upstream.fetchImpl)
  const shortTtl = { ...CONFIG, modelRefreshIntervalMs: 30 }
  await resolveModelCatalog(shortTtl, adapter, 'user_m', AbortSignal.timeout(5_000))
  await new Promise((r) => setTimeout(r, 60))
  const after = await resolveModelCatalog(shortTtl, adapter, 'user_m', AbortSignal.timeout(5_000))
  assert.deepEqual(after, ['mock-model'])
  assert.ok(upstream.collectUpstreamCalls().filter((c) => c.url.endsWith('/provider/v1/models')).length >= 2)
})

test('missing key, failed refresh, and empty catalog all fall back to the fixed list', async () => {
  resetModelCache()

  // 无 Key：固定列表，零上游调用
  const upstream = createRecordingUpstream([])
  const adapter = adapterWith(upstream.fetchImpl)
  const noKey = await resolveModelCatalog(CONFIG, adapter, undefined, AbortSignal.timeout(5_000))
  assert.deepEqual(noKey, [...FALLBACK_MODEL_IDS])
  assert.equal(upstream.collectUpstreamCalls().length, 0)

  // 上游失败：固定列表
  resetModelCache()
  const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  const failed = await resolveModelCatalog(CONFIG, adapterWith(failing), 'user_m', AbortSignal.timeout(5_000))
  assert.deepEqual(failed, [...FALLBACK_MODEL_IDS])

  // 空目录：固定列表
  resetModelCache()
  const empty = (async (input: unknown) => {
    if (String(input).endsWith('/provider/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(input).includes('/alpha/')) return new Response('{}', { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const emptied = await resolveModelCatalog(CONFIG, adapterWith(empty), 'user_m', AbortSignal.timeout(5_000))
  assert.deepEqual(emptied, [...FALLBACK_MODEL_IDS])
})

test('disabled dynamic discovery always uses the fixed list', async () => {
  resetModelCache()
  const upstream = createRecordingUpstream([])
  const disabled = await resolveModelCatalog(
    { ...CONFIG, useProviderModels: false },
    adapterWith(upstream.fetchImpl),
    'user_m',
    AbortSignal.timeout(5_000),
  )
  assert.deepEqual(disabled, [...FALLBACK_MODEL_IDS])
  assert.equal(upstream.collectUpstreamCalls().length, 0)
})

test('fallback result is not recorded as a successful refresh', async () => {
  resetModelCache()
  const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  const adapter = adapterWith(failing)
  await resolveModelCatalog(CONFIG, adapter, 'user_m', AbortSignal.timeout(5_000))
  // 失败后缓存仍为空：换可用上游可立即刷新
  const upstream = createRecordingUpstream([])
  const recovered = await resolveModelCatalog(CONFIG, adapterWith(upstream.fetchImpl), 'user_m', AbortSignal.timeout(5_000))
  assert.deepEqual(recovered, ['mock-model'])
})
