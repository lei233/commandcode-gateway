import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadConfig } from '../src/config.ts'

function tempConfigFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccgw-config-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, content, 'utf8')
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('defaults apply when file and env are silent', () => {
  const { path, cleanup } = tempConfigFile('{}')
  try {
    const config = loadConfig(path, {})
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 3000)
    assert.equal(config.maxBodyBytes, 100 * 1024 * 1024)
    assert.equal(config.streamIdleTimeoutMs, 30_000)
    assert.equal(config.nonStreamIdleTimeoutMs, 90_000)
    assert.equal(config.maxInflight, 0)
    assert.equal(config.clientDrainTimeoutMs, 0)
    assert.equal(config.keepAliveTimeoutMs, 65_000)
    assert.equal(config.useProviderModels, true)
    assert.equal(config.modelRefreshIntervalMs, 300_000)
    assert.equal(config.apiBase, 'https://api.commandcode.ai')
  } finally {
    cleanup()
  }
})

test('config file overrides built-in defaults', () => {
  const { path, cleanup } = tempConfigFile(JSON.stringify({
    host: '127.0.0.1',
    port: 3050,
    useProviderModels: false,
    modelRefreshIntervalMs: 60_000,
  }))
  try {
    const config = loadConfig(path, {})
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 3050)
    assert.equal(config.useProviderModels, false)
    assert.equal(config.modelRefreshIntervalMs, 60_000)
  } finally {
    cleanup()
  }
})

test('environment variables override config file', () => {
  const { path, cleanup } = tempConfigFile(JSON.stringify({ host: '127.0.0.1', port: 3050 }))
  try {
    const config = loadConfig(path, {
      HOST: '0.0.0.0',
      PORT: '8080',
      CC_MAX_BODY_MB: '10',
      CC_STREAM_IDLE_MS: '1234',
      CC_NONSTREAM_IDLE_MS: '5678',
      CC_MAX_INFLIGHT: '5',
      CC_CLIENT_DRAIN_TIMEOUT_MS: '2500',
      CC_KEEPALIVE_TIMEOUT_MS: '70000',
      CC_USE_PROVIDER_MODELS: 'false',
    })
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 8080)
    assert.equal(config.maxBodyBytes, 10 * 1024 * 1024)
    assert.equal(config.streamIdleTimeoutMs, 1234)
    assert.equal(config.nonStreamIdleTimeoutMs, 5678)
    assert.equal(config.maxInflight, 5)
    assert.equal(config.clientDrainTimeoutMs, 2500)
    assert.equal(config.keepAliveTimeoutMs, 70_000)
    assert.equal(config.useProviderModels, false)
  } finally {
    cleanup()
  }
})

test('invalid env values fall back to file value or default', () => {
  const { path, cleanup } = tempConfigFile(JSON.stringify({ port: 3050 }))
  try {
    const config = loadConfig(path, { PORT: 'not-a-number' })
    assert.equal(config.port, 3050)
    const noFile = loadConfig(path, { PORT: '-3' })
    assert.equal(noFile.port, 3050)
  } finally {
    cleanup()
  }
})

test('zero is accepted only where allowed', () => {
  const { path, cleanup } = tempConfigFile('{}')
  try {
    assert.equal(loadConfig(path, { CC_MAX_INFLIGHT: '0' }).maxInflight, 0)
    assert.equal(loadConfig(path, { CC_CLIENT_DRAIN_TIMEOUT_MS: '0' }).clientDrainTimeoutMs, 0)
    // PORT and body limit treat zero as invalid and fall back.
    assert.equal(loadConfig(path, { PORT: '0' }).port, 3000)
    assert.equal(loadConfig(path, { CC_MAX_BODY_MB: '0' }).maxBodyBytes, 100 * 1024 * 1024)
  } finally {
    cleanup()
  }
})

test('repository config.json preset listens on 0.0.0.0:3050', () => {
  const config = loadConfig(join(import.meta.dirname, '..', 'config.json'), {})
  assert.equal(config.host, '0.0.0.0')
  assert.equal(config.port, 3050)
})

test('malformed config file throws with path context', () => {
  const { path, cleanup } = tempConfigFile('{ not json')
  try {
    assert.throws(() => loadConfig(path, {}), /cannot load config file/)
  } finally {
    cleanup()
  }
})
