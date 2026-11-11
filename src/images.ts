/**
 * 用户消息 data URL 图片与请求内存附件。
 *
 * 职责：解析 data URL（mediaType 白名单 + canonical base64 校验）、用 sharp
 * 解码校验并取尺寸、构造请求级 AttachmentStore（内存 Map，请求结束即释放）。
 * adapter 通过 resolveAttachments 取 store，实际只调用 readImageRequest：
 * 按 target（长边 1568、编码后 ≤1MiB）缩放重编码，质量递减至预算内。
 * 首版拒绝 HTTP(S) 外链（chat.ts 准入时已 400）；image_url.detail 兼容
 * 接收但不映射上游。网关不额外设计独立的压缩/尺寸/数量策略，准入边界
 * 遵循 DSH 附件接口的 imageLimits。
 */

import sharp from 'sharp'
import type { OutputInfo } from 'sharp'

import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './runtime.ts'

/** 图片请求错误：data URL 解码/校验失败，按 400 处理。 */
export class ImageRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageRequestError'
  }
}

const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 网关图片准入边界（对齐 vendor 默认 limits 的量级，个人部署）。 */
export const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 8,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 10_000,
  mediaTypes: MEDIA_TYPES,
}

interface ParsedDataUrl {
  mediaType: ImageMediaType
  bytes: Uint8Array
}

/** 解析 base64 data URL；非白名单类型或非 canonical base64 抛 ImageRequestError。 */
export function parseImageDataUrl(dataUrl: string): ParsedDataUrl {
  const match = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.*)$/s)
  if (!match) throw new ImageRequestError('image_url.url must be a base64 data URL')
  const mediaType = match[1] as ImageMediaType
  if (!MEDIA_TYPES.includes(mediaType)) {
    throw new ImageRequestError(`unsupported image media type: ${mediaType}`)
  }
  const base64 = match[2]
  // canonical base64：长度为 4 的倍数且仅含字母表字符
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ImageRequestError('image data URL must carry canonical base64')
  }
  let buffer: Uint8Array
  try {
    buffer = Uint8Array.from(Buffer.from(base64, 'base64'))
  } catch {
    throw new ImageRequestError('image data URL base64 decode failed')
  }
  if (buffer.byteLength === 0) throw new ImageRequestError('image data URL carries empty bytes')
  if (buffer.byteLength > IMAGE_LIMITS.maxImageBytes) {
    throw new ImageRequestError(`image exceeds the ${IMAGE_LIMITS.maxImageBytes} byte limit`)
  }
  return { mediaType, bytes: buffer }
}

/** 用 sharp 解码校验并返回尺寸；损坏图片抛 ImageRequestError。 */
async function decodeWithMetadata(mediaType: ImageMediaType, bytes: Uint8Array): Promise<{ width: number; height: number }> {
  try {
    const image = sharp(bytes, { failOn: 'error' })
    const meta = await image.metadata()
    if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) {
      throw new ImageRequestError('image carries no usable dimensions')
    }
    if (meta.width > IMAGE_LIMITS.maxImageDimension || meta.height > IMAGE_LIMITS.maxImageDimension) {
      throw new ImageRequestError(`image dimensions exceed ${IMAGE_LIMITS.maxImageDimension}px`)
    }
    if (meta.width * meta.height > IMAGE_LIMITS.maxImagePixels) {
      throw new ImageRequestError('image exceeds the pixel budget')
    }
    void mediaType
    return { width: meta.width, height: meta.height }
  } catch (error) {
    if (error instanceof ImageRequestError) throw error
    throw new ImageRequestError('image bytes failed to decode')
  }
}

interface StoredEntry {
  ref: ImageAttachmentRef
  bytes: Uint8Array
}

/** 请求级内存附件服务；结构化实现 + 边界 cast（vendor 测试实证模式）。 */
class InMemoryImageStore {
  private readonly entries = new Map<string, StoredEntry>()
  readonly imageLimits = IMAGE_LIMITS

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await decodeWithMetadata(input.mediaType, input.data)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const { width, height } = await decodeWithMetadata(input.mediaType, input.data)
    const attachmentId = `ccgw-${crypto.randomUUID()}`
    const ref: ImageAttachmentRef = {
      attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width,
      height,
      ...(input.name !== undefined ? { name: input.name } : {}),
    }
    this.entries.set(attachmentId, { ref, bytes: input.data })
    return ref
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const entry = this.entries.get(String(ref.attachmentId))
    if (!entry) throw new ImageRequestError(`no stored image for ${String(ref.attachmentId)}`)
    return { ref, data: entry.bytes }
  }

  /** 请求版本生成：按 target 缩放（不放大）重编码，质量递减至 ≤ maxBytes。 */
  async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<RequestImageAttachment> {
    const entry = this.entries.get(String(ref.attachmentId))
    if (!entry) throw new ImageRequestError(`no stored image for ${String(ref.attachmentId)}`)
    const original = sharp(entry.bytes, { failOn: 'error' })
    const meta = await original.metadata()
    const sourceWidth = meta.width ?? ref.width
    const sourceHeight = meta.height ?? ref.height

    const needsResize = sourceWidth > target.width || sourceHeight > target.height
    const pipeline = needsResize
      ? original.resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true })
      : original

    // 编码格式沿用原 mediaType；png/gif 无质量阶梯，jpeg/webp 递减质量。
    const isJpeg = entry.ref.mediaType === 'image/jpeg'
    const isWebp = entry.ref.mediaType === 'image/webp'
    const qualities: Array<number | undefined> = isJpeg || isWebp ? [90, 80, 70, 60, 50, 40] : [undefined]
    let output: { data: Uint8Array; info: OutputInfo } | undefined
    for (const quality of qualities) {
      const formatted = quality === undefined
        ? pipeline.clone().toFormat(isWebp ? 'webp' : isJpeg ? 'jpeg' : 'png')
        : pipeline.clone().toFormat(isWebp ? 'webp' : 'jpeg', { quality })
      const result = await formatted.toBuffer({ resolveWithObject: true })
      if (result.info.size <= target.maxBytes) {
        output = result
        break
      }
      output = result
    }
    // 全部超预算时保留最小尝试（最后一档），行为对齐 adapter 注释：
    // keeps its smallest quality-ladder output when no quality fits.
    const { data, info } = output!
    const width = info.width || target.width
    const height = info.height || target.height
    return {
      variantId: `req-${String(ref.attachmentId)}-${width}x${height}` as RequestImageAttachment['variantId'],
      attachment: ref,
      data,
      mediaType: ref.mediaType,
      bytes: data.byteLength,
      width,
      height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: info.channels === 4,
    }
  }
}

/** 创建请求级附件 store；请求正常完成、失败或取消后随作用域丢弃。 */
export function createRequestAttachments(): AttachmentStore & { store: InMemoryImageStore } {
  const store = new InMemoryImageStore()
  return Object.assign(store, { store }) as unknown as AttachmentStore & { store: InMemoryImageStore }
}

/**
 * 将 data URL 列表准入为附件引用：逐张校验后统一保存（失败不产生部分引用）。
 * 返回 store（供 adapter resolveAttachments 使用）与按输入顺序的引用数组。
 */
export async function admitImageDataUrls(
  dataUrls: string[],
): Promise<{ store: AttachmentStore & { store: InMemoryImageStore }; refs: ImageAttachmentRef[] }> {
  if (dataUrls.length > IMAGE_LIMITS.maxImagesPerMessage) {
    throw new ImageRequestError(`a message may carry at most ${IMAGE_LIMITS.maxImagesPerMessage} images`)
  }
  const store = createRequestAttachments()
  const refs: ImageAttachmentRef[] = []
  for (const dataUrl of dataUrls) {
    const { mediaType, bytes } = parseImageDataUrl(dataUrl)
    const ref = await store.store.saveImage({ mediaType, data: bytes })
    refs.push(ref)
  }
  return { store, refs }
}
