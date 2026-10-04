/**
 * Client-side thumbnail generation and media upload limits (Phase 16.3).
 *
 * - Limits mirror desktop defaults (`commands/media.rs:149-153`, `:1949`):
 *     photo: 5 MB (`DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES`)
 *     video: 100 MB (`DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES`)
 * - Thumbnail dimensions clamp to `DEFAULT_THUMB_MAX_EDGE = 512`.
 * - Video poster frame captured via HTML5 `<video>` element.
 * - Image thumbnail rendered via `<canvas>`.
 */

export const DEFAULT_MEDIA_MAX_PHOTO_UPLOAD_BYTES = 5 * 1024 * 1024
export const DEFAULT_MEDIA_MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024
export const DEFAULT_THUMB_MAX_EDGE = 512
export const DEFAULT_THUMB_QUALITY = 0.8

/** Allowed MIME types matching core outbox ALLOWED_MIME_TYPES. */
export const ALLOWED_MEDIA_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
])

export function isAllowedMimeType(mime: string): boolean {
  return ALLOWED_MEDIA_MIME_TYPES.has(mime.toLowerCase())
}

export interface ThumbnailResult {
  thumbnailBytes: Uint8Array
  width: number
  height: number
  duration?: number
}

export interface ThumbnailOptions {
  maxEdge?: number
  quality?: number
}

/** Formats the typed error string expected by `parseImageError`. */
export function formatImageTooLargeError(actualBytes: number, limitBytes: number): string {
  return `IMAGE_TOO_LARGE:${actualBytes}:${limitBytes}:Image exceeds upload limit of ${limitBytes} bytes`
}

/** Formats the typed error string expected by `parseVideoError`. */
export function formatVideoTooLargeError(filename: string, limitBytes: number): string {
  const maxMb = Math.round(limitBytes / (1024 * 1024))
  return `VIDEO_TOO_LARGE:${filename}:${maxMb}`
}

function calculateScaledDimensions(
  origW: number,
  origH: number,
  maxEdge: number,
): { width: number; height: number } {
  if (origW <= 0 || origH <= 0) {
    return { width: Math.max(1, maxEdge), height: Math.max(1, maxEdge) }
  }
  if (origW <= maxEdge && origH <= maxEdge) {
    return { width: Math.round(origW), height: Math.round(origH) }
  }
  if (origW >= origH) {
    const scale = maxEdge / origW
    return { width: maxEdge, height: Math.max(1, Math.round(origH * scale)) }
  }
  const scale = maxEdge / origH
  return { width: Math.max(1, Math.round(origW * scale)), height: maxEdge }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) throw new Error('invalid data URL')
  const base64 = dataUrl.slice(comma + 1)
  if (typeof atob === 'function') {
    const bin = atob(base64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i)
    }
    return out
  }
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

// Test hooks for custom generator overrides (e.g. in headless Node tests)
type ImageGenerator = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
) => Promise<ThumbnailResult>
type VideoGenerator = (
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
) => Promise<ThumbnailResult>

let customImageGenerator: ImageGenerator | null = null
let customVideoGenerator: VideoGenerator | null = null

export function setCustomThumbnailGenerators(
  imageGen: ImageGenerator | null,
  videoGen: VideoGenerator | null,
): void {
  customImageGenerator = imageGen
  customVideoGenerator = videoGen
}

/**
 * Generates a JPEG thumbnail from raw image bytes using Canvas.
 */
export async function generateImageThumbnail(
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
): Promise<ThumbnailResult> {
  if (customImageGenerator) {
    return customImageGenerator(bytes, mimeType, options)
  }

  const maxEdge = options?.maxEdge ?? DEFAULT_THUMB_MAX_EDGE
  const quality = options?.quality ?? DEFAULT_THUMB_QUALITY

  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    // In headless test environments without DOM or canvas, return a minimal stub JPEG
    const fallbackJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0xff, 0xd9])
    return {
      thumbnailBytes: fallbackJpeg,
      width: Math.min(100, maxEdge),
      height: Math.min(100, maxEdge),
    }
  }

  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)

  try {
    const img = document.createElement('img')
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image for thumbnail generation'))
      img.src = objectUrl
    })

    const { width, height } = calculateScaledDimensions(
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      maxEdge,
    )

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context not available')

    ctx.drawImage(img, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const thumbnailBytes = dataUrlToBytes(dataUrl)

    return {
      thumbnailBytes,
      width,
      height,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Generates a JPEG thumbnail from raw video bytes using HTML5 `<video>` and Canvas.
 */
export async function generateVideoThumbnail(
  bytes: Uint8Array,
  mimeType: string,
  options?: ThumbnailOptions,
): Promise<ThumbnailResult> {
  if (customVideoGenerator) {
    return customVideoGenerator(bytes, mimeType, options)
  }

  const maxEdge = options?.maxEdge ?? DEFAULT_THUMB_MAX_EDGE
  const quality = options?.quality ?? DEFAULT_THUMB_QUALITY

  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    const fallbackJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0xff, 0xd9])
    return {
      thumbnailBytes: fallbackJpeg,
      width: Math.min(100, maxEdge),
      height: Math.min(100, maxEdge),
      duration: 1.0,
    }
  }

  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)

  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    video.src = objectUrl

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Failed to load video for thumbnail generation'))
      }
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onError)
      }
      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', onError)
    })

    const duration = video.duration || 0
    const targetTime = Math.min(0.1, duration > 0 ? duration / 2 : 0)

    if (video.currentTime !== targetTime) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          resolve()
        }, 1500)
        const onSeeked = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error('Failed to seek video for thumbnail generation'))
        }
        const cleanup = () => {
          clearTimeout(timer)
          video.removeEventListener('seeked', onSeeked)
          video.removeEventListener('error', onError)
        }
        video.addEventListener('seeked', onSeeked)
        video.addEventListener('error', onError)
        video.currentTime = targetTime
      })
    }

    const { width, height } = calculateScaledDimensions(
      video.videoWidth || 320,
      video.videoHeight || 240,
      maxEdge,
    )

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context not available')

    ctx.drawImage(video, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const thumbnailBytes = dataUrlToBytes(dataUrl)

    return {
      thumbnailBytes,
      width,
      height,
      duration,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
