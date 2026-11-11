/** 真实上游验收（独立执行：npm run test:live；需 .env 提供 COMMANDCODE_API_KEY）。 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

// 缺配置是失败不是 skip（fail-closed 环境门）
const apiKey = process.env['COMMANDCODE_API_KEY']
assert.ok(apiKey, 'Set COMMANDCODE_API_KEY in .env')
const baseUrl = process.env['CCGW_BASE_URL'] ?? 'http://127.0.0.1:3050'
const model = process.env['COMMANDCODE_TEST_MODEL'] ?? 'claude-sonnet-4-6'

test('live: health and models endpoints', async () => {
  const health = await fetch(`${baseUrl}/health`)
  assert.equal(health.status, 200)
  const models = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } })
  assert.equal(models.status, 200)
  const body = await models.json() as { data: Array<{ id: string }> }
  assert.ok(body.data.length > 0)
})

test('live: non-stream JSON generation', async () => {
  const probe = `probe-${Date.now()}`
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `Reply with exactly: ${probe}` }],
      max_tokens: 512,
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { choices: Array<{ message: { content: string } }> }
  assert.ok(body.choices[0]?.message.content?.includes(probe), 'answer echoes the probe')
})

test('live: SSE stream ends with exactly one [DONE]', async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'count from 1 to 3' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  const frames = text.split('\n\n').filter(Boolean).filter((f) => f.startsWith('data: '))
  assert.equal(frames.filter((f) => f === 'data: [DONE]').length, 1)
  assert.equal(frames.at(-1), 'data: [DONE]')
})
