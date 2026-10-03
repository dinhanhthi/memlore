/**
 * Media cache settings and stats (Phase 11.3): the existing Settings UI (`MediaCacheSettings`)
 * drives the web cache through the desktop command names and wire shape.
 *
 *  - `get_media_cache_stats` -> `{usedBytes, maxBytes}`: usage as the evictor defines it (every
 *    cached `files` and `blobs` ciphertext byte, from `sizes()`: no bytes are loaded) and the
 *    EFFECTIVE budget (`min(500 MB, 50% of quota)`, lowered by the user limit).
 *  - `set_media_cache_limit {bytes}`: the user limit can only LOWER the budget (the evictor clamps
 *    it to 50 MB..cap). It is persisted in `meta` (`cache-limit-bytes`, kept by `clearCache()`) and
 *    re-applied by the evictor on unlock. Enforced immediately; returns the new stats.
 *  - `clear_media_cache` deletes ONLY the `blobs` rows (full media and thumbnails). Drafts, retained
 *    intents, the device record (`change_seq`), `meta` hints, the authority files and entry payloads
 *    are never opened. `clear_font_cache` is desktop-only and is not mapped.
 *  - `media-cache:stats-changed` (payload = the stats) is emitted after a limit change, a clear and
 *    any write-triggered or evicting run of the evictor (`installCacheStatsEmitter`).
 *
 * Every handler rejects with `VaultLockedError` while locked (the Settings page only exists in an
 * unlocked app).
 */

import { emitFromBackend } from '../../tauri/event'
import { getKeyRing } from '../keys'
import type { Handler } from '../router'
import {
  getBudgetBytes,
  isEvictorRunning,
  lowerByLimit,
  maybeEvict,
  setBudgetBytes,
  setStatsListener,
} from '../storage/evictor'
import { CACHE_LIMIT_KEY, openWebDb, type WebDb } from '../storage/idb'

export const MEDIA_CACHE_STATS_EVENT = 'media-cache:stats-changed'

export interface MediaCacheStats {
  usedBytes: number
  maxBytes: number
}

export interface CacheEnv {
  openDb: () => Promise<Pick<WebDb, 'files' | 'blobs' | 'meta'>>
  /** Throws `VaultLockedError` when locked. */
  assertUnlocked: () => void
}

let injected: Partial<CacheEnv> = {}
let dbPromise: Promise<Pick<WebDb, 'files' | 'blobs' | 'meta'>> | null = null

const cacheEnv = (): CacheEnv => ({
  openDb: () => openWebDb(),
  assertUnlocked: () => {
    getKeyRing()
  },
  ...injected,
})

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureCacheEnv(partial: Partial<CacheEnv>): void {
  injected = partial
  dbPromise = null
}

function getDb(): Promise<Pick<WebDb, 'files' | 'blobs' | 'meta'>> {
  dbPromise ??= cacheEnv()
    .openDb()
    .catch((error: unknown) => {
      dbPromise = null
      throw error
    })
  return dbPromise
}

async function readStats(): Promise<MediaCacheStats> {
  const db = await getDb()
  const [files, blobs, budget] = await Promise.all([
    db.files.sizes(),
    db.blobs.sizes(),
    getBudgetBytes(),
  ])
  // Before the evictor starts (between unlock and `app:unlocked`) it knows no limit: show the
  // persisted one, read-only, without touching the evictor's state.
  const maxBytes = isEvictorRunning()
    ? budget
    : lowerByLimit(budget, (await db.meta.get(CACHE_LIMIT_KEY).catch(() => undefined))?.value)
  const usedBytes = [...files, ...blobs].reduce((sum, m) => sum + m.size, 0)
  return { usedBytes, maxBytes }
}

async function statsAndEmit(): Promise<MediaCacheStats> {
  const stats = await readStats()
  emitFromBackend(MEDIA_CACHE_STATS_EVENT, stats)
  return stats
}

/** Parses the `bytes` argument: a finite number >= 0; a huge value is clamped to a safe integer. */
function parseLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('set_media_cache_limit: bytes must be a finite number >= 0')
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
}

export const cacheHandlers: Record<string, Handler> = {
  get_media_cache_stats: async () => {
    cacheEnv().assertUnlocked()
    return readStats()
  },
  set_media_cache_limit: async ({ bytes }) => {
    cacheEnv().assertUnlocked()
    const limit = parseLimit(bytes)
    const db = await getDb()
    await db.meta.put({ key: CACHE_LIMIT_KEY, value: limit })
    cacheEnv().assertUnlocked() // a lock during the write must not set a limit on a stopped evictor
    setBudgetBytes(limit)
    await maybeEvict('manual')
    return statsAndEmit()
  },
  clear_media_cache: async () => {
    cacheEnv().assertUnlocked()
    const db = await getDb()
    await db.blobs.clear()
    return statsAndEmit()
  },
}

/** Emits `media-cache:stats-changed` after write-triggered and evicting evictor runs. Idempotent. */
export function installCacheStatsEmitter(): void {
  setStatsListener(() => {
    void readStats().then(
      (stats) => emitFromBackend(MEDIA_CACHE_STATS_EVENT, stats),
      () => undefined,
    )
  })
}
