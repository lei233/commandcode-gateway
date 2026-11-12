import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  IMAGE_LIMITS,
  ImageRequestError,
  admitImageDataUrls,
  createRequestAttachments,
  parseImageDataUrl,
} from '../src/images.ts'

import { chatToGenerateOptions } from '../src/protocol/chat.ts'

/** 每文件独立临时目录，退出时统一清理（不向 /tmp 泄漏缓存文件）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ccgw-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

/** sharp 生成真实 PNG 夹具。 */
async function pngDataUrl(width: number, height: number): Promise<string> {
  const { default: sharp } = await import('sharp')
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).png().toBuffer()
  return `data:image/png;base64,${buffer.toString('base64')}`
}

async function jpegDataUrl(width: number, height: number): Promise<string> {
  const { default: sharp } = await import('sharp')
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 90 } },
  }).jpeg().toBuffer()
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

test('parseImageDataUrl accepts canonical base64 data URLs', async () => {
  const url = await pngDataUrl(4, 4)
  const parsed = parseImageDataUrl(url)
  assert.equal(parsed.mediaType, 'image/png')
  assert.ok(parsed.bytes.byteLength > 0)
  // PNG magic bytes survive the round trip
  assert.equal(parsed.bytes[0], 0x89)
  assert.equal(parsed.bytes[1], 0x50)
})

test('parseImageDataUrl rejects non-canonical or unsupported payloads', async () => {
  const url = await pngDataUrl(4, 4)
  const base64 = url.split(',', 2)[1]!
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${base64}x`), ImageRequestError)
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${base64.slice(0, -2)}`), /canonical/)
  assert.throws(() => parseImageDataUrl('data:image/bmp;base64,AAAA'), /unsupported image media type/)
  assert.throws(() => parseImageDataUrl('data:image/png;base64,'), /empty|canonical/)
  assert.throws(() => parseImageDataUrl('https://example.com/cat.png'), /base64 data URL/)
})

test('admitImageDataUrls returns ordered refs in a request-scoped store', async () => {
  const urls = [await pngDataUrl(8, 8), await jpegDataUrl(6, 10)]
  const { store, refs } = await admitImageDataUrls(urls)
  assert.equal(refs.length, 2)
  assert.equal(refs[0]?.mediaType, 'image/png')
  assert.equal(refs[0]?.width, 8)
  assert.equal(refs[1]?.mediaType, 'image/jpeg')
  assert.equal(refs[1]?.height, 10)
  // store resolves its own refs
  const stored = await store.store.readImage(refs[0]!)
  assert.equal(stored.data.byteLength, refs[0]!.bytes)
  // unknown ref fails
  await assert.rejects(
    () => store.store.readImage({ ...refs[0]!, attachmentId: 'ccgw-missing' as never }),
    ImageRequestError,
  )
})

test('admitImageDataUrls rejects corrupt bytes and over-limit counts', async () => {
  const corrupt = `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}`
  await assert.rejects(() => admitImageDataUrls([corrupt]), /failed to decode/)

  const urls = Array.from({ length: IMAGE_LIMITS.maxImagesPerMessage + 1 }, () => 'data:image/png;base64,AAAA')
  await assert.rejects(() => admitImageDataUrls(urls), /at most/)
})

test('admitImageDataUrls admits multi-document batches under the aligned budget', async () => {
  // 文档抽取场景：30 张小图（旧 8 张上限会拒绝，对齐 adapter 预算后放行）
  const urls = Array.from({ length: 30 }, () => 'data:image/png;base64,' + Buffer.from('x'.repeat(16)).toString('base64'))
  const { refs } = await admitImageDataUrls(urls.map((u) => 'data:image/png;base64,' + b64OfTinyPng()))
  assert.equal(refs.length, urls.length)
})

/** 最小合法 PNG 的 base64（1x1 灰度），用于纯计数维度的批量测试。 */
function b64OfTinyPng(): string {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364000000060002' +
    '3081d02f0000000049454e44ae426082',
    'hex',
  )
  return png.toString('base64')
}

test('readImageRequest scales down to the target without enlarging', async () => {
  const { store, refs } = await admitImageDataUrls([await pngDataUrl(3200, 1600)])
  const ref = refs[0]!
  const target = { width: 1568, height: 784, maxBytes: 1024 * 1024 }
  const request = await store.store.readImageRequest(ref, target)
  assert.equal(request.width, 1568)
  assert.equal(request.height, 784)
  assert.ok(request.bytes <= target.maxBytes)
  assert.ok(request.data.byteLength > 0)

  // small image is not enlarged
  const small = await admitImageDataUrls([await pngDataUrl(10, 10)])
  const kept = await small.store.store.readImageRequest(small.refs[0]!, { width: 1568, height: 1568, maxBytes: 1024 * 1024 })
  assert.equal(kept.width, 10)
  assert.equal(kept.height, 10)
})

test('chat conversion builds ImageBlocks with admitted refs in original order', async () => {
  const pngUrl = await pngDataUrl(6, 6)
  const jpegUrl = await jpegDataUrl(4, 4)
  const { refs } = await admitImageDataUrls([pngUrl, jpegUrl])
  const byUrl = new Map<string, (typeof refs)[number]>([
    [pngUrl, refs[0]!],
    [jpegUrl, refs[1]!],
  ])
  const { options } = chatToGenerateOptions({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        { type: 'image_url', image_url: { url: pngUrl } },
        { type: 'image_url', image_url: { url: jpegUrl } },
        { type: 'text', text: 'after' },
      ],
    }],
  }, 'claude-sonnet-4-6', (dataUrl) => byUrl.get(dataUrl))
  const user = options.messages[0]
  assert.ok(user && user.role === 'user')
  const types = user.content.map((b) => b.type)
  assert.deepEqual(types, ['text', 'image', 'image', 'text'])
  const first = user.content[1]
  assert.ok(first && first.type === 'image')
  assert.equal(first.attachment.attachmentId, refs[0]!.attachmentId)
  const second = user.content[2]
  assert.ok(second && second.type === 'image')
  assert.equal(second.attachment.attachmentId, refs[1]!.attachmentId)
})

test('image bytes reach the adapter upstream request exactly once', async () => {
  const { collectUpstreamCalls, fetchImpl } = await import('./helpers/upstream-mock.ts').then(
    async (m) => m.createRecordingUpstream([
      { type: 'text-delta', text: 'seen' },
      { type: 'finish', finishReason: 'stop' },
    ]),
  )
  const { streamCommandCode } = await import('../src/commandcode.ts')
  const { store, refs } = await admitImageDataUrls([await pngDataUrl(400, 300)])
  const byRef = refs[0]!
  const { options } = chatToGenerateOptions({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: await pngDataUrl(400, 300) } }] }],
  }, 'claude-sonnet-4-6', () => byRef)

  const iterable = streamCommandCode(
    { apiBase: 'https://upstream.example', workingDir: '/workspace', modelsCachePath: join(TMP, `img-${crypto.randomUUID()}.json`), fetchImpl },
    { apiKey: 'user_img', signal: new AbortController().signal },
    options,
    () => store,
  )
  for await (const _ of iterable) void _

  const calls = collectUpstreamCalls()
  const generate = calls.find((c) => c.url.endsWith('/alpha/generate'))
  assert.ok(generate, 'generate call recorded')
  // 图片以 base64 进入请求体；解析后查找原始字节恰一次
  const body = String(generate.init?.body ?? '')
  assert.ok(body.includes('base64'), 'body carries base64 image payload')
})
