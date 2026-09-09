import {
  getMediaStatus,
  readMediaBytes,
  readMediaThumbnailBytes,
  resolveMedia,
  resolveMediaThumbnail,
  type MediaStatus,
} from '../../lib/tauri'
import { emitMediaCached } from '../../lib/mediaEvents'

/**
 * Module-level cache for resolved media blob URLs.
 *
 * The editor remounts every TipTap NodeView when a user switches entries
 * (the underlying Y.Doc changes, ProseMirror tears down its node views).
 * Without this cache, every revisit to an entry would re-fetch the same
 * bytes from Tauri IPC and re-decode them — producing the flash of blank
 * skeleton + image pop-in the user reported.
 *
 * With the cache, the second mount finds an already-built blob URL plus
 * dimensions, sets initial state synchronously on the very first render,
 * and `<img>` mounts with src already set. No skeleton flash, no IPC
 * round-trip.
 *
 * Why module-level (not React Context / Zustand): the cache outlives any
 * component tree — Settings panel and Editor unmount completely when the
 * user closes/reopens an entry, but a Map living in this module keeps
 * its entries until the page reloads. That's the desired behaviour: blob
 * URLs are cheap to keep around as long as the underlying SQLite row
 * exists, and the LRU cap (`MAX_ENTRIES`) keeps memory bounded.
 *
 * Eviction strategy: insertion-order LRU. JavaScript Maps preserve
 * insertion order, so on eviction we delete the oldest entry. On
 * eviction we also `URL.revokeObjectURL` the blob to release the
 * underlying bytes — otherwise long sessions would leak memory.
 *
 * On `deleteMedia`, callers MUST invoke `invalidateMediaCache(mediaId)`
 * to revoke and remove stale entries; otherwise a deleted media id
 * could still resolve to its stale blob URL (and the file behind it is
 * already gone on disk).
 */

export interface CachedMedia {
  /** The blob URL ready to assign to `<img src>` / `<video src>`. */
  blobUrl: string
  /** Status row at the moment the blob was created. */
  status: MediaStatus
  /** Whether the blob was read from the thumbnail file or the full image. */
  useThumbnail: boolean
}

const MAX_ENTRIES = 200

const cache = new Map<string, CachedMedia>()
/** Pending fetches deduped so concurrent mounts of the same image share a
 * single IPC round-trip rather than each kicking off their own. */
const pending = new Map<string, Promise<CachedMedia | null>>()
/**
 * In-flight `ensureMediaCached` triggers, keyed by `(mediaId, useThumbnail)`.
 * Separate from `pending` (which keys the blob-resolution promise) — declared
 * up-front so `invalidateMediaCache` can drop entries on row deletion
 * without violating the temporal-dead-zone for the symbol.
 */
const ensureInflight = new Map<string, Promise<boolean>>()
/**
 * Negative cache for failed ensure attempts. See block-comment at the
 * `ensureMediaCached` definition further down for the full clearing rules.
 */
const ensureFailures = new Map<string, number>()
const ENSURE_FAILURE_TTL_MS = 30_000

/**
 * Cap concurrent backend downloads so a Media Gallery render with N cells
 * doesn't fire N × 3 Drive API calls in a single tick. Google Drive returns
 * 429/5xx under burst load; before this limit, opening the gallery on first
 * sync caused half the thumbnails to land in `ensureFailures` for 30s while
 * the user stared at gray placeholders. The limit is small (4) because the
 * Drive read path itself fans out into 3 sub-requests (root → device →
 * file lookup), so the effective parallelism is ~12 in-flight API calls.
 */
const ENSURE_CONCURRENCY_LIMIT = 4
let ensureRunning = 0
const ensureQueue: Array<() => void> = []

function acquireEnsureSlot(): Promise<void> {
  if (ensureRunning < ENSURE_CONCURRENCY_LIMIT) {
    ensureRunning++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    ensureQueue.push(() => {
      ensureRunning++
      resolve()
    })
  })
}

function releaseEnsureSlot(): void {
  ensureRunning--
  const next = ensureQueue.shift()
  if (next) next()
}

const keyOf = (mediaId: string, useThumbnail: boolean) =>
  `${mediaId}|${useThumbnail ? 'thumb' : 'full'}`

/**
 * Decode a blob URL through a detached `Image` element to learn its
 * intrinsic `naturalWidth`/`naturalHeight`. Resolves to `null` when the
 * browser cannot decode the format (e.g. an audio MIME accidentally
 * routed here, or a corrupt blob) — caller treats that as "dims
 * unknown" and falls back to the fixed-height skeleton.
 */
function measureImageDims(blobUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight })
      } else {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = blobUrl
  })
}

function evictIfFull() {
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    const entry = cache.get(oldest)
    if (entry) URL.revokeObjectURL(entry.blobUrl)
    cache.delete(oldest)
  }
}

function touch(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  // Re-insert to move to most-recent in iteration order.
  cache.delete(key)
  cache.set(key, entry)
}

/**
 * Synchronous lookup. Returns `null` when the entry hasn't been
 * resolved yet — callers should fall back to {@link resolveCachedMedia}.
 */
export function peekCachedMedia(mediaId: string, useThumbnail: boolean): CachedMedia | null {
  const key = keyOf(mediaId, useThumbnail)
  const entry = cache.get(key)
  if (entry) touch(key)
  return entry ?? null
}

/**
 * Resolve a media id to a blob URL + status, populating the cache on
 * first miss. Concurrent calls for the same key share a single
 * underlying IPC fetch. Returns `null` when the media row exists but
 * is cloud-only (no local file to make a blob from) — the caller
 * should render its cloud-download UI in that case.
 */
export function resolveCachedMedia(
  mediaId: string,
  useThumbnail: boolean,
): Promise<CachedMedia | null> {
  const key = keyOf(mediaId, useThumbnail)
  const hit = cache.get(key)
  if (hit) {
    touch(key)
    return Promise.resolve(hit)
  }
  const inflight = pending.get(key)
  if (inflight) return inflight

  const task = (async () => {
    const status = await getMediaStatus(mediaId)
    // `cachedLocally` reflects the FULL file (`storage_path`). For
    // thumbnail-only consumers (entry-list covers), accept the row as
    // resolvable when a peer-downloaded `thumbnailPath` is present even
    // if the full image hasn't been fetched yet. `read_media_thumbnail_bytes`
    // on the backend already returns the thumb file directly in that case.
    const haveFull = status.cachedLocally && !!status.localPath
    const haveThumb = !!status.thumbnailPath
    if (!haveFull && !(useThumbnail && haveThumb)) {
      return null
    }
    const bytes = useThumbnail
      ? await readMediaThumbnailBytes(mediaId)
      : await readMediaBytes(mediaId)
    // When `useThumbnail` is true AND the row actually has a thumbnail file,
    // the bytes we just read are the on-disk JPEG. Pin the Blob's MIME to
    // `image/jpeg` so a video tile rendering with `useThumbnail` doesn't
    // wrap JPEG bytes in a `video/mp4` Blob (the `<video>` element would
    // fail to decode and show broken-video). When `useThumbnail` is true
    // but `haveThumb` is false (no thumb file → backend falls through to
    // the full media), keep the row's native MIME so a video file stays
    // decodable as a video.
    const usingThumbBytes = useThumbnail && haveThumb
    const blobType = usingThumbBytes ? 'image/jpeg' : status.fileType || 'application/octet-stream'
    const blob = new Blob([new Uint8Array(bytes)], { type: blobType })
    const blobUrl = URL.createObjectURL(blob)

    // Fallback dimension measurement. The backend tries to populate
    // `width`/`height` at insert time, but it cannot decode HEIC (the
    // `image` crate ships without the `heif` feature and Apple's HEIC
    // containers don't always carry `PixelXDimension` in EXIF). When
    // the status row leaves dims null, decode the blob URL through a
    // throwaway `Image()` to read `naturalWidth`/`naturalHeight` —
    // that's the canonical browser-side aspect-ratio source and works
    // for every format the webview itself can render (which is the
    // only situation that matters, since we're about to show this
    // image anyway). Audio/video skip this path.
    let finalStatus = status
    if (status.fileType.startsWith('image/') && (status.width == null || status.height == null)) {
      const dims = await measureImageDims(blobUrl)
      if (dims) {
        finalStatus = { ...status, width: dims.width, height: dims.height }
      }
    }
    const entry: CachedMedia = { blobUrl, status: finalStatus, useThumbnail }
    evictIfFull()
    cache.set(key, entry)
    return entry
  })()
    .catch((err) => {
      // Don't poison the cache — let the next mount retry. Re-throw so the
      // caller sees the error.
      throw err
    })
    .finally(() => {
      pending.delete(key)
    })

  pending.set(key, task)
  return task
}

/**
 * Look up just the status row, populating from cache when present.
 * Used to render the aspect-ratio skeleton box BEFORE we know whether
 * bytes are local or cloud-only.
 */
export function peekCachedStatus(mediaId: string): MediaStatus | null {
  // Prefer the thumbnail variant since it's the most-used in the gallery,
  // then fall back to the full variant for the editor.
  for (const useThumbnail of [false, true]) {
    const entry = cache.get(keyOf(mediaId, useThumbnail))
    if (entry) return entry.status
  }
  return null
}

/**
 * Drop every cache entry for the given media id and revoke its blob URL.
 * Must be called after `deleteMedia` so stale blobs don't outlive their
 * SQLite row.
 */
export function invalidateMediaCache(mediaId: string): void {
  for (const useThumbnail of [false, true]) {
    const key = keyOf(mediaId, useThumbnail)
    const entry = cache.get(key)
    if (entry) {
      URL.revokeObjectURL(entry.blobUrl)
      cache.delete(key)
    }
    // Defensive: drop any auxiliary state so a same-UUID re-insert
    // (sync churn, tests) doesn't inherit a stale negative-cache or
    // in-flight promise from the deleted row. The orphaned in-flight
    // promise resolves harmlessly into a discarded result.
    ensureFailures.delete(key)
    ensureInflight.delete(key)
  }
}

/**
 * `ensureInflight` and `ensureFailures` are declared at the top of the
 * module (alongside `cache` + `pending`) so `invalidateMediaCache` can
 * reference them without a temporal-dead-zone violation. The full clearing
 * rules for `ensureFailures`:
 *   - TTL expiry (every call checks `ENSURE_FAILURE_TTL_MS` since the
 *     last recorded failure for the same key)
 *   - A subsequent `ensureMediaCached` call that succeeds for the same
 *     key (we drop the record at the top of the success path)
 *   - `clearEnsureFailureFor(mediaId)` — public hook that the manual
 *     "tap to ↓" path uses after `resolveMedia` succeeds, so a thumb-
 *     side failure isn't held for 30 s after the full side has clearly
 *     proved the row is reachable.
 *   - `invalidateMediaCache(mediaId)` (called from `deleteMedia`) which
 *     drops every record for the deleted id so a same-UUID re-insert
 *     doesn't inherit stale state.
 */

/**
 * Idempotent backend trigger: ensures that `mediaId`'s bytes (thumbnail
 * when `useThumbnail`, full file otherwise) are present locally on disk.
 * Does NOT return a blob URL — callers should subsequently invoke
 * `resolveCachedMedia` (or rely on a `memlore:media-changed` event +
 * re-peek) to hydrate the cache. Use this for auto-download flows
 * (entry list cover, entry view inline images, gallery thumbnails)
 * where the caller cares only that the file lands locally.
 *
 * Resolves `true` if the file is present after the call, `false`
 * otherwise (transient failure, no cloud copy, …). Never throws —
 * callers don't need a try/catch around it.
 *
 * Concurrent calls for the same (mediaId, useThumbnail) share one
 * Drive round-trip. Recent failures are short-circuited for
 * `ENSURE_FAILURE_TTL_MS` to avoid hammering an unreachable provider.
 */
export function ensureMediaCached(mediaId: string, useThumbnail: boolean): Promise<boolean> {
  const key = keyOf(mediaId, useThumbnail)

  // Fast path: blob already cached.
  if (cache.has(key)) return Promise.resolve(true)

  // Short-circuit recent failures.
  const lastFail = ensureFailures.get(key)
  if (lastFail !== undefined && Date.now() - lastFail < ENSURE_FAILURE_TTL_MS) {
    return Promise.resolve(false)
  }

  // Dedupe concurrent triggers.
  const inflight = ensureInflight.get(key)
  if (inflight) return inflight

  const task = (async () => {
    // Re-check the negative cache after the queue wait — a slot may have
    // taken seconds to free up, and a peer ensure may have succeeded
    // (clearing the entry) or failed (refreshing it) in the meantime.
    await acquireEnsureSlot()
    try {
      const lastFailAfterWait = ensureFailures.get(key)
      if (
        lastFailAfterWait !== undefined &&
        Date.now() - lastFailAfterWait < ENSURE_FAILURE_TTL_MS
      ) {
        return false
      }
      if (cache.has(key)) return true

      const status = await getMediaStatus(mediaId)
      // For thumbnail consumers, the local thumbnail file is enough.
      if (useThumbnail && status.thumbnailPath) return true
      // For full consumers, local file must exist.
      if (!useThumbnail && status.cachedLocally && status.localPath) return true

      // Trigger backend download.
      if (useThumbnail) {
        await resolveMediaThumbnail(mediaId)
      } else {
        await resolveMedia(mediaId)
      }
      // Drop any prior failure record so subsequent peers can also retry.
      ensureFailures.delete(key)
      // Successful download — broadcast on the BYTES-CACHED channel so
      // EntryCard and MediaAttachment instances can re-peek the module
      // cache and hydrate. We deliberately do NOT emit `media-changed`
      // here: that event invalidates the TanStack `['media']` queries,
      // which would refetch the gallery and cause every other visible
      // cell's auto-DL effect to re-run on every individual download
      // completing — quadratic. The DB row itself did not change; only
      // the on-disk cache, which is what the dedicated channel signals.
      emitMediaCached()
      return true
    } catch {
      ensureFailures.set(key, Date.now())
      return false
    } finally {
      releaseEnsureSlot()
    }
  })().finally(() => {
    ensureInflight.delete(key)
  })

  ensureInflight.set(key, task)
  return task
}

/**
 * Drop the negative-cache record for `mediaId` (both thumbnail and full
 * variants) so the next `ensureMediaCached` call retries immediately
 * rather than waiting for the 30 s TTL.
 *
 * Production callers: `MediaAttachment.downloadFullImage` invokes this
 * after a manual "tap to ↓" successfully downloads the full file — if
 * the thumb-side ensure had failed earlier (e.g. corrupt thumbnail row),
 * the user manually proving the row is reachable should let any other
 * thumb-side consumer retry without waiting.
 */
export function clearEnsureFailureFor(mediaId: string): void {
  for (const useThumbnail of [false, true]) {
    ensureFailures.delete(keyOf(mediaId, useThumbnail))
  }
}

/** @deprecated Use `clearEnsureFailureFor` (kept as alias for any callers). */
export const _clearEnsureFailureForTests = clearEnsureFailureFor

/** Test / debug only — clear everything. */
export function _resetMediaCacheForTests(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.blobUrl)
  cache.clear()
  pending.clear()
  ensureInflight.clear()
  ensureFailures.clear()
  ensureQueue.length = 0
  ensureRunning = 0
}
