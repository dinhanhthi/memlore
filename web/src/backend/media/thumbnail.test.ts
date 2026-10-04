import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES,
  DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES,
  DEFAULT_THUMB_MAX_EDGE,
  DEFAULT_THUMB_QUALITY,
  formatImageTooLargeError,
  formatVideoTooLargeError,
  generateImageThumbnail,
  generateVideoThumbnail,
  setCustomThumbnailGenerators,
} from './thumbnail'
import { parseImageError } from '../../../../src/hooks/useImageInsertPicker'
import { parseVideoError } from '../../../../src/hooks/useVideoInsertPicker'

afterEach(() => {
  setCustomThumbnailGenerators(null, null)
  vi.unstubAllGlobals()
})

describe('thumbnail constants & error formatters', () => {
  it('defines correct upload limit constants matching desktop', () => {
    expect(DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES).toBe(5 * 1024 * 1024)
    expect(DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES).toBe(100 * 1024 * 1024)
    expect(DEFAULT_THUMB_MAX_EDGE).toBe(512)
    expect(DEFAULT_THUMB_QUALITY).toBe(0.8)
  })

  it('formatImageTooLargeError round-trips through parseImageError', () => {
    const raw = formatImageTooLargeError(6_000_000, 5_242_880)
    const parsed = parseImageError(raw)
    expect(parsed).toEqual({
      kind: 'image-too-large',
      actualBytes: 6_000_000,
      limitBytes: 5_242_880,
    })
  })

  it('formatVideoTooLargeError round-trips through parseVideoError', () => {
    const raw = formatVideoTooLargeError('my_trip.mp4', 104_857_600)
    const parsed = parseVideoError(raw)
    expect(parsed).toEqual({
      kind: 'video-too-large',
      filename: 'my_trip.mp4',
      maxSizeMb: 100,
    })
  })
})

describe('generateImageThumbnail', () => {
  it('returns a fallback JPEG when document is undefined in node', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const res = await generateImageThumbnail(bytes, 'image/png')
    expect(res.thumbnailBytes.length).toBeGreaterThan(0)
    expect(res.thumbnailBytes[0]).toBe(0xff)
    expect(res.thumbnailBytes[1]).toBe(0xd8)
    expect(res.width).toBeLessThanOrEqual(DEFAULT_THUMB_MAX_EDGE)
    expect(res.height).toBeLessThanOrEqual(DEFAULT_THUMB_MAX_EDGE)
  })

  it('respects custom thumbnail generator override', async () => {
    const customBytes = new Uint8Array([99, 98, 97])
    setCustomThumbnailGenerators(
      async () => ({ thumbnailBytes: customBytes, width: 256, height: 128 }),
      null,
    )
    const res = await generateImageThumbnail(new Uint8Array([1]), 'image/jpeg')
    expect(res.thumbnailBytes).toBe(customBytes)
    expect(res.width).toBe(256)
    expect(res.height).toBe(128)
  })
})

describe('generateVideoThumbnail', () => {
  it('returns a fallback JPEG when document is undefined in node', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8])
    const res = await generateVideoThumbnail(bytes, 'video/mp4')
    expect(res.thumbnailBytes.length).toBeGreaterThan(0)
    expect(res.thumbnailBytes[0]).toBe(0xff)
    expect(res.thumbnailBytes[1]).toBe(0xd8)
    expect(res.duration).toBe(1.0)
  })

  it('respects custom thumbnail generator override', async () => {
    const customBytes = new Uint8Array([88, 77])
    setCustomThumbnailGenerators(null, async () => ({
      thumbnailBytes: customBytes,
      width: 320,
      height: 240,
      duration: 12.5,
    }))
    const res = await generateVideoThumbnail(new Uint8Array([1]), 'video/mp4')
    expect(res.thumbnailBytes).toBe(customBytes)
    expect(res.width).toBe(320)
    expect(res.height).toBe(240)
    expect(res.duration).toBe(12.5)
  })
})
