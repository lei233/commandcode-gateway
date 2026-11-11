/**
 * 测试共享的 mock 上游：注入 fetchImpl，记录外发请求并按脚本化 NDJSON
 * 事件流应答 /alpha/generate；应答 /provider/v1/models 与账号探测端点。
 */

export interface RecordedCall {
  url: string
  init?: Record<string, unknown>
}

export interface RecordingUpstream {
  fetchImpl: typeof fetch
  collectUpstreamCalls: () => RecordedCall[]
}

const encoder = new TextEncoder()

export function createRecordingUpstream(events: Array<Record<string, unknown>>): RecordingUpstream {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: unknown, init?: unknown) => {
    const url = String(input)
    calls.push({ url, init: init as Record<string, unknown> })
    if (url.endsWith('/provider/v1/models')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-model', name: 'Mock', context_length: 64000 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/alpha/whoami') || url.includes('/alpha/billing')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = (async function* () {
      for (const event of events) {
        yield encoder.encode(`${JSON.stringify(event)}\n`)
      }
    })()
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetchImpl, collectUpstreamCalls: () => calls }
}
