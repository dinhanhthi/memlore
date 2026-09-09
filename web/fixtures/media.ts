import type { MediaRow, MediaStatus, GalleryMediaRow } from '../../src/lib/tauri'
import type { MapPin } from '../../src/types/map'
import {
  ENTRY_1_ID,
  ENTRY_2_ID,
  ENTRY_3_ID,
  ENTRY_4_ID,
  ENTRY_5_ID,
  ENTRY_6_ID,
  ENTRY_7_ID,
  ENTRY_8_ID,
  ENTRY_9_ID,
  ENTRY_10_ID,
  ENTRY_11_ID,
  ENTRY_12_ID,
  ENTRY_13_ID,
  ENTRY_14_ID,
  ENTRY_15_ID,
  ENTRY_16_ID,
  ENTRY_17_ID,
  ENTRY_18_ID,
  ENTRY_19_ID,
  ENTRY_20_ID,
  entries,
} from './entries'
import { JOURNAL_DAILY_ID, JOURNAL_WORK_ID, JOURNAL_TRAVEL_ID } from './journals'

/** Parent-entry title + excerpt for gallery chrome (rich card footer + carousel). */
const ENTRY_GALLERY_META = new Map(
  entries.map((e) => {
    const preview = e.preview_text ?? ''
    // A few fixture entries intentionally have `title: null` (untitled in the
    // Entries list). Gallery cards fall back to the literal "Untitled" for an
    // empty string, which looks broken in the preview — invent a short title
    // from the first sentence of the excerpt so every card feels lived-in.
    let title = e.title ?? ''
    if (!title && preview) {
      const first = preview.split(/[.!?]/)[0]?.trim() ?? ''
      title = first.length > 48 ? `${first.slice(0, 45).trimEnd()}…` : first
    }
    if (!title) title = 'Quiet note'
    return [e.id, { title, preview }] as const
  }),
)

function galleryEntryMeta(entryId: string): { entryTitle: string; entryPreview: string } {
  const meta = ENTRY_GALLERY_META.get(entryId)
  if (meta) return { entryTitle: meta.title, entryPreview: meta.preview }
  return { entryTitle: 'Quiet note', entryPreview: '' }
}

// 1×1 solid-color PNGs — one per media item for visual variety in the gallery.
// Generated via Python: png_1x1(r, g, b) → zlib-compressed PNG → base64.
const COLOR_PNG: Record<string, string> = {
  indigo:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNITvsIAALqAbsneUV/AAAAAElFTkSuQmCC',
  pink: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN44zETAAPxAc6x3OsqAAAAAElFTkSuQmCC',
  amber:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4Oo8bAAQqAZ9SpbPIAAAAAElFTkSuQmCC',
  emerald:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mMQ2NkIAAInAUt79MTdAAAAAElFTkSuQmCC',
  blue: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOwbvoGAAKvAbSJsn7VAAAAAElFTkSuQmCC',
  red: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN47+ICAAOdAXjXHRJ+AAAAAElFTkSuQmCC',
  violet:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mPojvkGAANTAd5bBcfQAAAAAElFTkSuQmCC',
  teal: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mMQ2bEMAAJWAXPppz4uAAAAAElFTkSuQmCC',
  orange:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4WSwGAAPrAYPccVSnAAAAAElFTkSuQmCC',
  cyan: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNg23YFAAJWAZE7kIkfAAAAAElFTkSuQmCC',
  lime: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNoOSMGAAM+AWccYhdxAAAAAElFTkSuQmCC',
  purple:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNYEfodAAOdAfWKtQvfAAAAAElFTkSuQmCC',
  rose: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN4KOsBAAMpAUfAQxDcAAAAAElFTkSuQmCC',
  sky: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mPgW/oSAAJhAZ13CQERAAAAAElFTkSuQmCC',
  green:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNQOhoHAAJSAUZEuwQDAAAAAElFTkSuQmCC',
  yellow:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mO4Wc4GAAODAVdRpmzLAAAAAElFTkSuQmCC',
}

// Maps each fake media ID to a color key
const MEDIA_COLOR_KEY: Record<string, string> = {
  'media-lisbon-001': 'indigo',
  'media-sintra-002': 'pink',
  'media-porto-003': 'amber',
  'media-porto-004': 'emerald',
  'media-morning-005': 'blue',
  'media-cafe-006': 'red',
  'media-sunset-007': 'violet',
  'media-rain-008': 'teal',
  'media-park-009': 'orange',
  'media-market-010': 'cyan',
  'media-trail-011': 'lime',
  'media-mural-012': 'purple',
  'media-beach-013': 'rose',
  'media-lake-014': 'sky',
  'media-garden-015': 'green',
  'media-roof-016': 'yellow',
  'media-dinner-017': 'rose',
  'media-lisbon-018': 'cyan',
  'media-lisbon-019': 'lime',
  'media-lisbon-020': 'purple',
  'media-sintra-018': 'orange',
  'media-sintra-019': 'teal',
}

/** Returns solid-color 1×1 PNG bytes for a given media ID. Falls back to a neutral gray. */
export function coloredPngBytesFor(mediaId: string): number[] {
  const key = MEDIA_COLOR_KEY[mediaId] ?? 'sky'
  const b64 = COLOR_PNG[key] ?? COLOR_PNG['sky']!
  return Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// Real Unsplash photos for the entry-list covers so the preview looks like a
// lived-in journal instead of solid color swatches. Each ID is a verified
// Unsplash `photo-*` slug; the fetch below requests a small square crop.
// This is the browser preview harness — network is fine here, and
// `photoBytesFor` degrades to the offline color PNG when a request fails.
const UNSPLASH_PHOTO_ID: Record<string, string> = {
  'media-lisbon-001': 'photo-1585208798174-6cedd86e019a',
  'media-sintra-002': 'photo-1555881400-74d7acaacd8b',
  'media-porto-003': 'photo-1513735492246-483525079686',
  'media-porto-004': 'photo-1518977676601-b53f82aba655',
  'media-morning-005': 'photo-1414235077428-338989a2e8c0',
  'media-cafe-006': 'photo-1495474472287-4d71bcdd2085',
  'media-sunset-007': 'photo-1470071459604-3b5ec3a7fe05',
  'media-rain-008': 'photo-1428592953211-077101b2021b',
  'media-park-009': 'photo-1441974231531-c6227db76b6e',
  'media-market-010': 'photo-1507525428034-b723cf961d3e',
  'media-trail-011': 'photo-1465146344425-f00d5f5c8f07',
  'media-mural-012': 'photo-1499856871958-5b9627545d1a',
  'media-beach-013': 'photo-1502602898657-3e91760cbb34',
  'media-lake-014': 'photo-1524850011238-e3d235c7d4c9',
  'media-garden-015': 'photo-1533105079780-92b9be482077',
  'media-roof-016': 'photo-1519677100203-a0e668c92439',
  'media-dinner-017': 'photo-1504674900247-0877df9cc836',
  'media-lisbon-018': 'photo-1476514525535-07fb3b4ae5f1',
  'media-lisbon-019': 'photo-1449824913935-59a10b8d2000',
  'media-lisbon-020': 'photo-1477959858617-67f85cf4f1df',
  'media-sintra-018': 'photo-1500534623283-312aade485b7',
  'media-sintra-019': 'photo-1493246507139-91e8fad9978e',
}

// Verified Unsplash photo IDs shared across the gallery fixtures so every
// `gal-img-*` / `gal-vid-*` card renders a real photo instead of a solid
// color swatch. `galleryPhotoIdFor` picks one deterministically per media id
// (stable across renders, no flicker). Audio items are excluded — they have
// no thumbnail and render the inline AudioPlayer instead.
const GALLERY_PHOTO_POOL: readonly string[] = [
  'photo-1585208798174-6cedd86e019a',
  'photo-1555881400-74d7acaacd8b',
  'photo-1513735492246-483525079686',
  'photo-1518977676601-b53f82aba655',
  'photo-1414235077428-338989a2e8c0',
  'photo-1495474472287-4d71bcdd2085',
  'photo-1470071459604-3b5ec3a7fe05',
  'photo-1428592953211-077101b2021b',
  'photo-1441974231531-c6227db76b6e',
  'photo-1507525428034-b723cf961d3e',
  'photo-1465146344425-f00d5f5c8f07',
  'photo-1499856871958-5b9627545d1a',
  'photo-1502602898657-3e91760cbb34',
  'photo-1524850011238-e3d235c7d4c9',
  'photo-1533105079780-92b9be482077',
  'photo-1519677100203-a0e668c92439',
  'photo-1504674900247-0877df9cc836',
  'photo-1476514525535-07fb3b4ae5f1',
  'photo-1449824913935-59a10b8d2000',
  'photo-1477959858617-67f85cf4f1df',
  'photo-1500534623283-312aade485b7',
  'photo-1493246507139-91e8fad9978e',
  'photo-1431440869543-efaf3388c585',
  'photo-1481627834876-b7833e8f5570',
  'photo-1442512595331-e89e73853f31',
  'photo-1509042239860-f550ce710b93',
]

/** Deterministic Unsplash photo for a gallery fixture id (audio excluded). */
function galleryPhotoIdFor(mediaId: string): string | undefined {
  // Gallery fixtures use ids like gal-img-001 / gal-vid-001 / gal-aud-001.
  if (!mediaId.startsWith('gal-')) return undefined
  if (mediaId.startsWith('gal-aud-')) return undefined
  let hash = 0
  for (let i = 0; i < mediaId.length; i++) hash = (hash * 31 + mediaId.charCodeAt(i)) >>> 0
  return GALLERY_PHOTO_POOL[hash % GALLERY_PHOTO_POOL.length]!
}

/**
 * Size variant for Unsplash fixture photos.
 * - `thumb`: small square crop for gallery cells / list covers
 *   (`read_media_thumbnail_bytes`)
 * - `full`: large long-edge image for lightbox / editor inline
 *   (`read_media_bytes`) — preserves aspect ratio so the carousel
 *   shows the real photo, not a 200×200 swatch
 */
export type PhotoBytesSize = 'thumb' | 'full'

/**
 * Fetches a real Unsplash photo for `mediaId` and returns its raw bytes,
 * matching the `read_media_thumbnail_bytes` / `read_media_bytes` contract.
 * Entry media resolve via `UNSPLASH_PHOTO_ID`; gallery image/video fixtures
 * resolve via `galleryPhotoIdFor`. Falls back to the offline solid-color PNG
 * when the id is unmapped (audio / unknown) or the network request fails, so
 * an offline preview still renders every card.
 *
 * Pass `size: 'full'` for lightbox / full-file reads; default is `thumb`.
 */
export async function photoBytesFor(
  mediaId: string,
  opts: { size?: PhotoBytesSize } = {},
): Promise<number[]> {
  const photoId = UNSPLASH_PHOTO_ID[mediaId] ?? galleryPhotoIdFor(mediaId)
  if (!photoId) return coloredPngBytesFor(mediaId)
  try {
    // Thumb: square crop for grid cells. Full: large long-edge, no crop,
    // so MediaGalleryCarousel / editor inline show a real photo size.
    const url =
      opts.size === 'full'
        ? `https://images.unsplash.com/${photoId}?w=1600&q=80`
        : `https://images.unsplash.com/${photoId}?w=200&h=200&fit=crop&q=80`
    const res = await fetch(url)
    if (!res.ok) return coloredPngBytesFor(mediaId)
    const buf = await res.arrayBuffer()
    return Array.from(new Uint8Array(buf))
  } catch {
    return coloredPngBytesFor(mediaId)
  }
}

const now = Math.floor(Date.now() / 1000)

function makeMedia(id: string, entryId: string, fileName: string, sortOrder: number): MediaRow {
  return {
    id,
    entry_id: entryId,
    file_name: fileName,
    file_type: 'image/jpeg',
    storage_provider: 'local',
    storage_path: `/fake/media/${id}.jpg`,
    thumbnail_path: `/fake/media/${id}_thumb.jpg`,
    upload_status: 'uploaded',
    uploaded_at: now - 60,
    file_size: 102400,
    cloud_path: null,
    last_accessed_at: now,
    sort_order: sortOrder,
    created_at: now - 24 * 60 * 60,
    exif_date: null,
    exif_latitude: null,
    exif_longitude: null,
    insertion_mode: 'inline',
    duration_seconds: null,
  }
}

// ─── Media IDs ───────────────────────────────────────────────────────────────

export const MEDIA_1_ID = 'media-lisbon-001'
export const MEDIA_2_ID = 'media-sintra-002'
export const MEDIA_3_ID = 'media-porto-003'
export const MEDIA_4_ID = 'media-porto-004'
export const MEDIA_5_ID = 'media-morning-005'
export const MEDIA_6_ID = 'media-cafe-006'
export const MEDIA_7_ID = 'media-sunset-007'
export const MEDIA_8_ID = 'media-rain-008'
export const MEDIA_9_ID = 'media-park-009'
export const MEDIA_10_ID = 'media-market-010'
export const MEDIA_11_ID = 'media-trail-011'
export const MEDIA_12_ID = 'media-mural-012'
export const MEDIA_13_ID = 'media-beach-013'
export const MEDIA_14_ID = 'media-lake-014'
export const MEDIA_15_ID = 'media-garden-015'
export const MEDIA_16_ID = 'media-roof-016'
export const MEDIA_17_ID = 'media-dinner-017'
export const MEDIA_18_ID = 'media-lisbon-018'
export const MEDIA_19_ID = 'media-lisbon-019'
export const MEDIA_20_ID = 'media-lisbon-020'
export const MEDIA_21_ID = 'media-sintra-018'
export const MEDIA_22_ID = 'media-sintra-019'

// ─── Media rows ──────────────────────────────────────────────────────────────

export const mediaRows: MediaRow[] = [
  // Original entries
  makeMedia(MEDIA_1_ID, ENTRY_6_ID, 'alfama-view.jpg', 0),
  makeMedia(MEDIA_2_ID, ENTRY_9_ID, 'sintra-palace.jpg', 0),
  makeMedia(MEDIA_3_ID, ENTRY_19_ID, 'porto-bridge.jpg', 0),
  makeMedia(MEDIA_4_ID, ENTRY_19_ID, 'azulejos.jpg', 1),
  // Additional entries
  makeMedia(MEDIA_5_ID, ENTRY_1_ID, 'morning-light.jpg', 0),
  makeMedia(MEDIA_6_ID, ENTRY_2_ID, 'corner-cafe.jpg', 0),
  makeMedia(MEDIA_7_ID, ENTRY_3_ID, 'golden-sunset.jpg', 0),
  makeMedia(MEDIA_8_ID, ENTRY_3_ID, 'rainy-window.jpg', 1),
  makeMedia(MEDIA_9_ID, ENTRY_4_ID, 'park-bench.jpg', 0),
  makeMedia(MEDIA_10_ID, ENTRY_5_ID, 'weekend-market.jpg', 0),
  makeMedia(MEDIA_11_ID, ENTRY_7_ID, 'hiking-trail.jpg', 0),
  makeMedia(MEDIA_12_ID, ENTRY_7_ID, 'street-mural.jpg', 1),
  makeMedia(MEDIA_13_ID, ENTRY_10_ID, 'sea-beach.jpg', 0),
  makeMedia(MEDIA_14_ID, ENTRY_11_ID, 'mountain-lake.jpg', 0),
  makeMedia(MEDIA_15_ID, ENTRY_12_ID, 'rooftop-garden.jpg', 0),
  makeMedia(MEDIA_16_ID, ENTRY_13_ID, 'rooftop-terrace.jpg', 0),
  makeMedia(MEDIA_17_ID, ENTRY_14_ID, 'dinner-friends.jpg', 0),
  makeMedia(MEDIA_18_ID, ENTRY_6_ID, 'lisbon-cobblestones.jpg', 1),
  makeMedia(MEDIA_19_ID, ENTRY_6_ID, 'lisbon-tram.jpg', 2),
  makeMedia(MEDIA_20_ID, ENTRY_6_ID, 'pasteis-bakery.jpg', 3),
  makeMedia(MEDIA_21_ID, ENTRY_9_ID, 'sintra-palace-tower.jpg', 1),
  makeMedia(MEDIA_22_ID, ENTRY_9_ID, 'sintra-garden-path.jpg', 2),
]

export const mediaByEntry: Record<string, MediaRow[]> = {
  [ENTRY_6_ID]: [mediaRows[0], mediaRows[17], mediaRows[18], mediaRows[19]],
  [ENTRY_9_ID]: [mediaRows[1], mediaRows[20], mediaRows[21]],
  [ENTRY_19_ID]: [mediaRows[2], mediaRows[3]],
  [ENTRY_1_ID]: [mediaRows[4]],
  [ENTRY_2_ID]: [mediaRows[5]],
  [ENTRY_3_ID]: [mediaRows[6], mediaRows[7]],
  [ENTRY_4_ID]: [mediaRows[8]],
  [ENTRY_5_ID]: [mediaRows[9]],
  [ENTRY_7_ID]: [mediaRows[10], mediaRows[11]],
  [ENTRY_10_ID]: [mediaRows[12]],
  [ENTRY_11_ID]: [mediaRows[13]],
  [ENTRY_12_ID]: [mediaRows[14]],
  [ENTRY_13_ID]: [mediaRows[15]],
  [ENTRY_14_ID]: [mediaRows[16]],
}

/** Full MediaStatus shape — camelCase as returned by `get_media_status`. */
export function makeMediaStatus(mediaId: string): MediaStatus {
  return {
    mediaId,
    cachedLocally: true,
    hasCloudCopy: false,
    localPath: `/fake/media/${mediaId}.jpg`,
    thumbnailPath: `/fake/media/${mediaId}_thumb.jpg`,
    fileType: 'image/jpeg',
    fileSize: null,
    compressed: false,
    // Left null so mediaCache.resolveCachedMedia measures the real blob's
    // natural dimensions instead of baking in a fake aspect ratio.
    width: null,
    height: null,
  }
}

/**
 * Status derived from the actual fixture row for `mediaId`, so the real
 * `fileType` and thumbnail presence are honored — audio rows keep their
 * null thumbnail and video rows keep their `video/*` type instead of being
 * fabricated as images. Unknown ids fall back to the generic image status.
 * Consumed by the `get_media_status` mock handler.
 */
export function makeMediaStatusFor(mediaId: string): MediaStatus {
  const row = mediaRows.find((r) => r.id === mediaId)
  if (row) {
    return {
      mediaId,
      cachedLocally: true,
      hasCloudCopy: false,
      localPath: row.storage_path,
      thumbnailPath: row.thumbnail_path,
      fileType: row.file_type,
      fileSize: null,
      compressed: false,
      width: null,
      height: null,
    }
  }
  const gal = galleryMediaRows.find((r) => r.id === mediaId)
  if (gal) {
    return {
      mediaId,
      cachedLocally: true,
      hasCloudCopy: false,
      localPath: gal.storagePath,
      thumbnailPath: gal.thumbnailPath,
      fileType: gal.fileType,
      fileSize: null,
      compressed: false,
      width: null,
      height: null,
    }
  }
  return makeMediaStatus(mediaId)
}

// ─── Color key extensions for gallery items ───────────────────────────────────

const ALL_COLOR_KEYS = [
  'indigo',
  'pink',
  'amber',
  'emerald',
  'blue',
  'red',
  'violet',
  'teal',
  'orange',
  'cyan',
  'lime',
  'purple',
  'rose',
  'sky',
  'green',
  'yellow',
]

function galleryColorKey(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return ALL_COLOR_KEYS[hash % ALL_COLOR_KEYS.length]!
}

// ─── Gallery Media Rows — 60 items spanning all formats ──────────────────────

function makeGalleryMedia(
  id: string,
  entryId: string,
  journalId: string,
  fileType: string,
  daysOld: number,
  durationSeconds: number | null = null,
): GalleryMediaRow {
  const ext = fileType.split('/')[1] ?? 'jpg'
  const ts = now - daysOld * 24 * 60 * 60
  const entryTs = ts - 60
  MEDIA_COLOR_KEY[id] = galleryColorKey(id)
  const { entryTitle, entryPreview } = galleryEntryMeta(entryId)
  return {
    id,
    entryId,
    journalId,
    fileType,
    storagePath: `/fake/gallery/${id}.${ext}`,
    thumbnailPath: fileType.startsWith('audio/') ? null : `/fake/gallery/${id}_thumb.${ext}`,
    cloudPath: null,
    uploadStatus: 'uploaded',
    createdAt: ts,
    entryDate: entryTs,
    durationSeconds,
    entryTitle,
    entryPreview,
  }
}

export const galleryMediaRows: GalleryMediaRow[] = [
  // ── Page 1 (items 1–20) ────────────────────────────────────────────────────
  // Images — jpeg
  makeGalleryMedia('gal-img-001', ENTRY_1_ID, JOURNAL_DAILY_ID, 'image/jpeg', 0),
  makeGalleryMedia('gal-img-002', ENTRY_2_ID, JOURNAL_DAILY_ID, 'image/jpeg', 1),
  makeGalleryMedia('gal-img-003', ENTRY_3_ID, JOURNAL_DAILY_ID, 'image/jpeg', 2),
  makeGalleryMedia('gal-img-004', ENTRY_4_ID, JOURNAL_WORK_ID, 'image/jpeg', 3),
  makeGalleryMedia('gal-img-005', ENTRY_5_ID, JOURNAL_WORK_ID, 'image/jpeg', 4),
  // Images — png
  makeGalleryMedia('gal-img-006', ENTRY_6_ID, JOURNAL_TRAVEL_ID, 'image/png', 5),
  makeGalleryMedia('gal-img-007', ENTRY_7_ID, JOURNAL_DAILY_ID, 'image/png', 6),
  makeGalleryMedia('gal-img-008', ENTRY_8_ID, JOURNAL_WORK_ID, 'image/png', 7),
  // Images — heic
  makeGalleryMedia('gal-img-009', ENTRY_9_ID, JOURNAL_TRAVEL_ID, 'image/heic', 8),
  makeGalleryMedia('gal-img-010', ENTRY_10_ID, JOURNAL_DAILY_ID, 'image/heic', 9),
  makeGalleryMedia('gal-img-011', ENTRY_11_ID, JOURNAL_DAILY_ID, 'image/heic', 10),
  // Images — webp
  makeGalleryMedia('gal-img-012', ENTRY_12_ID, JOURNAL_WORK_ID, 'image/webp', 11),
  makeGalleryMedia('gal-img-013', ENTRY_13_ID, JOURNAL_DAILY_ID, 'image/webp', 12),
  // Video — mp4
  makeGalleryMedia('gal-vid-001', ENTRY_14_ID, JOURNAL_DAILY_ID, 'video/mp4', 13),
  makeGalleryMedia('gal-vid-002', ENTRY_15_ID, JOURNAL_TRAVEL_ID, 'video/mp4', 14),
  makeGalleryMedia('gal-vid-003', ENTRY_16_ID, JOURNAL_WORK_ID, 'video/mp4', 15),
  // Audio — m4a
  makeGalleryMedia('gal-aud-001', ENTRY_17_ID, JOURNAL_DAILY_ID, 'audio/m4a', 16, 47),
  makeGalleryMedia('gal-aud-002', ENTRY_18_ID, JOURNAL_DAILY_ID, 'audio/m4a', 17, 123),
  makeGalleryMedia('gal-aud-003', ENTRY_19_ID, JOURNAL_TRAVEL_ID, 'audio/m4a', 18, 22),
  makeGalleryMedia('gal-aud-004', ENTRY_20_ID, JOURNAL_DAILY_ID, 'audio/mp3', 19, 305),

  // ── Page 2 (items 21–40) ───────────────────────────────────────────────────
  // Images — jpeg
  makeGalleryMedia('gal-img-014', ENTRY_1_ID, JOURNAL_DAILY_ID, 'image/jpeg', 20),
  makeGalleryMedia('gal-img-015', ENTRY_2_ID, JOURNAL_DAILY_ID, 'image/jpeg', 21),
  makeGalleryMedia('gal-img-016', ENTRY_3_ID, JOURNAL_DAILY_ID, 'image/jpeg', 22),
  makeGalleryMedia('gal-img-017', ENTRY_4_ID, JOURNAL_WORK_ID, 'image/jpeg', 23),
  // Images — png
  makeGalleryMedia('gal-img-018', ENTRY_5_ID, JOURNAL_WORK_ID, 'image/png', 24),
  makeGalleryMedia('gal-img-019', ENTRY_6_ID, JOURNAL_TRAVEL_ID, 'image/png', 25),
  makeGalleryMedia('gal-img-020', ENTRY_7_ID, JOURNAL_DAILY_ID, 'image/png', 26),
  // Images — heic
  makeGalleryMedia('gal-img-021', ENTRY_8_ID, JOURNAL_WORK_ID, 'image/heic', 27),
  makeGalleryMedia('gal-img-022', ENTRY_9_ID, JOURNAL_TRAVEL_ID, 'image/heic', 28),
  // Images — webp
  makeGalleryMedia('gal-img-023', ENTRY_10_ID, JOURNAL_DAILY_ID, 'image/webp', 29),
  makeGalleryMedia('gal-img-024', ENTRY_11_ID, JOURNAL_DAILY_ID, 'image/webp', 30),
  makeGalleryMedia('gal-img-025', ENTRY_12_ID, JOURNAL_WORK_ID, 'image/webp', 31),
  // Video — mp4
  makeGalleryMedia('gal-vid-004', ENTRY_13_ID, JOURNAL_DAILY_ID, 'video/mp4', 32),
  makeGalleryMedia('gal-vid-005', ENTRY_14_ID, JOURNAL_DAILY_ID, 'video/mp4', 33),
  // Video — quicktime / mov
  makeGalleryMedia('gal-vid-006', ENTRY_15_ID, JOURNAL_TRAVEL_ID, 'video/quicktime', 34),
  makeGalleryMedia('gal-vid-007', ENTRY_16_ID, JOURNAL_TRAVEL_ID, 'video/quicktime', 35),
  // Audio — aac, mp3
  makeGalleryMedia('gal-aud-005', ENTRY_17_ID, JOURNAL_DAILY_ID, 'audio/aac', 36, 88),
  makeGalleryMedia('gal-aud-006', ENTRY_18_ID, JOURNAL_DAILY_ID, 'audio/aac', 37, 204),
  makeGalleryMedia('gal-aud-007', ENTRY_19_ID, JOURNAL_TRAVEL_ID, 'audio/mp3', 38, 61),
  makeGalleryMedia('gal-aud-008', ENTRY_20_ID, JOURNAL_DAILY_ID, 'audio/mp3', 39, 397),

  // ── Page 3 (items 41–60) ───────────────────────────────────────────────────
  // Images — jpeg
  makeGalleryMedia('gal-img-026', ENTRY_1_ID, JOURNAL_DAILY_ID, 'image/jpeg', 40),
  makeGalleryMedia('gal-img-027', ENTRY_2_ID, JOURNAL_DAILY_ID, 'image/jpeg', 41),
  makeGalleryMedia('gal-img-028', ENTRY_3_ID, JOURNAL_DAILY_ID, 'image/jpeg', 42),
  makeGalleryMedia('gal-img-029', ENTRY_4_ID, JOURNAL_WORK_ID, 'image/jpeg', 43),
  makeGalleryMedia('gal-img-030', ENTRY_5_ID, JOURNAL_WORK_ID, 'image/jpeg', 44),
  // Images — png
  makeGalleryMedia('gal-img-031', ENTRY_6_ID, JOURNAL_TRAVEL_ID, 'image/png', 45),
  makeGalleryMedia('gal-img-032', ENTRY_7_ID, JOURNAL_DAILY_ID, 'image/png', 46),
  // Images — heic
  makeGalleryMedia('gal-img-033', ENTRY_8_ID, JOURNAL_WORK_ID, 'image/heic', 47),
  makeGalleryMedia('gal-img-034', ENTRY_9_ID, JOURNAL_TRAVEL_ID, 'image/heic', 48),
  makeGalleryMedia('gal-img-035', ENTRY_10_ID, JOURNAL_DAILY_ID, 'image/heic', 49),
  // Images — webp
  makeGalleryMedia('gal-img-036', ENTRY_11_ID, JOURNAL_DAILY_ID, 'image/webp', 50),
  makeGalleryMedia('gal-img-037', ENTRY_12_ID, JOURNAL_WORK_ID, 'image/webp', 51),
  makeGalleryMedia('gal-img-038', ENTRY_13_ID, JOURNAL_DAILY_ID, 'image/webp', 52),
  // Video — mp4
  makeGalleryMedia('gal-vid-008', ENTRY_14_ID, JOURNAL_DAILY_ID, 'video/mp4', 53),
  makeGalleryMedia('gal-vid-009', ENTRY_15_ID, JOURNAL_TRAVEL_ID, 'video/mp4', 54),
  makeGalleryMedia('gal-vid-010', ENTRY_16_ID, JOURNAL_WORK_ID, 'video/mp4', 55),
  // Video — quicktime
  makeGalleryMedia('gal-vid-011', ENTRY_17_ID, JOURNAL_TRAVEL_ID, 'video/quicktime', 56),
  makeGalleryMedia('gal-vid-012', ENTRY_18_ID, JOURNAL_TRAVEL_ID, 'video/quicktime', 57),
  // Audio — m4a, aac
  makeGalleryMedia('gal-aud-009', ENTRY_19_ID, JOURNAL_TRAVEL_ID, 'audio/m4a', 58, 142),
  makeGalleryMedia('gal-aud-010', ENTRY_20_ID, JOURNAL_DAILY_ID, 'audio/aac', 59, 76),
]

export const mapPins: MapPin[] = [
  {
    id: `entry:${ENTRY_6_ID}`,
    kind: 'entry',
    entryId: ENTRY_6_ID,
    latitude: 38.7139,
    longitude: -9.1334,
    label: 'Alfama, Lisbon',
    entryDate: Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60,
    thumbnailPath: null,
  },
  {
    id: `entry:${ENTRY_9_ID}`,
    kind: 'entry',
    entryId: ENTRY_9_ID,
    latitude: 38.7978,
    longitude: -9.3875,
    label: 'Sintra, Portugal',
    entryDate: Math.floor(Date.now() / 1000) - 9 * 24 * 60 * 60,
    thumbnailPath: null,
  },
  {
    id: `entry:${ENTRY_19_ID}`,
    kind: 'entry',
    entryId: ENTRY_19_ID,
    latitude: 41.1413,
    longitude: -8.6148,
    label: 'Ribeira, Porto',
    entryDate: Math.floor(Date.now() / 1000) - 55 * 24 * 60 * 60,
    thumbnailPath: null,
  },
  {
    id: 'photo:media-lisbon-001',
    kind: 'photo',
    entryId: ENTRY_6_ID,
    latitude: 38.7143,
    longitude: -9.1328,
    label: 'Alfama, Lisbon',
    entryDate: Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60,
    thumbnailPath: null,
  },
]
