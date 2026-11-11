import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { normalizeCredentials } from '../src/auth.ts'

test('extracts user_ token from Authorization Bearer', () => {
  const result = normalizeCredentials('Bearer user_abc123', undefined)
  assert.deepEqual(result, { ok: true, apiKey: 'user_abc123' })
})

test('token_user_ prefix normalizes to user_ token (substring match)', () => {
  const result = normalizeCredentials('Bearer token_user_abc123', undefined)
  assert.deepEqual(result, { ok: true, apiKey: 'user_abc123' })
})

test('extracts user_ token from x-api-key', () => {
  const result = normalizeCredentials(undefined, 'user_key-only')
  assert.deepEqual(result, { ok: true, apiKey: 'user_key-only' })
})

test('authorization takes precedence when both present and equal after normalization', () => {
  const result = normalizeCredentials('Bearer user_same', 'user_same')
  assert.deepEqual(result, { ok: true, apiKey: 'user_same' })
})

test('conflicting credentials in both headers return 400', () => {
  const result = normalizeCredentials('Bearer user_one', 'user_two')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 400)
    assert.match(result.message, /Conflicting/)
  }
})

test('missing credentials return 401', () => {
  assert.equal(normalizeCredentials(undefined, undefined).ok, false)
  const result = normalizeCredentials('Bearer sk-not-user-key', undefined)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 401)
})

test('header without user_ prefix but x-api-key valid succeeds', () => {
  const result = normalizeCredentials('Bearer something-else', 'user_from-x')
  assert.deepEqual(result, { ok: true, apiKey: 'user_from-x' })
})

test('empty headers return 401', () => {
  const result = normalizeCredentials('', '')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 401)
})
