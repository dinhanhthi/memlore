/**
 * Persisted web settings (Phase 17.2): a small allowlist of `get_setting` / `set_setting` keys the
 * web keeps across reloads, in the IDB `meta` store under `WEB_SETTING_PREFIX` (kept by
 * `clearCache()`, wiped by `clearAll()`). Every other key stays session-only (`router.ts`).
 *
 *  - `web_map_tiles_consent`: `'1'` = the user agreed that map tiles reveal the viewed area and
 *    their IP address to MapTiler. `'0'` (or a delete) REVOKES: it clears the consent and
 *    `map_tile_source`; the MapTiler key stays until it is deleted itself.
 *  - `map_tile_source`: `'maptiler'` or unset (`''` unsets, as `clearMapTileSource` writes), so
 *    `useMapSourceSettings` and `LeafletMap.tsx` work unchanged. Offline basemap and MapKit are
 *    desktop-only and refused.
 *  - `maptiler_api_key`: stored ONLY sealed. JS never sees a local KEK, so the key is sealed with
 *    the WASM media envelope under the unlocked content ring (`sealOutboxMedia`, the production
 *    wrapper over core `seal_media`; the plan's `sealMedia` export is test-only) and read back with
 *    `openMedia`. A ciphertext that no longer opens (key rotation, re-onboard) or a malformed
 *    record reads as absent, and the user enters the key again. `''` deletes it.
 *
 * `map_tile_source` reads as unset unless consent `'1'` is also stored, so a stray source (an old
 * write, a partial revoke) never enables MapTiler tiles on its own. A stored ciphertext longer than
 * `MAX_SEALED_HEX_LENGTH` is not opened and reads as absent.
 *
 * Reads, writes and deletes reject with `VaultLockedError` while locked. Nothing is cached in
 * memory, so there is nothing to clear on lock. An unexpected stored value reads as unset.
 */

import type { Core } from '../../core/core'
import { loadCore } from '../../core/core'
import { getKeyRing, type KeyRing } from '../keys'
import { WEB_SETTING_PREFIX, openWebDb, type WebDb } from '../storage/idb'

export const WEB_SETTING_KEYS = [
  'web_map_tiles_consent',
  'map_tile_source',
  'maptiler_api_key',
] as const
export type WebSettingKey = (typeof WEB_SETTING_KEYS)[number]

const CONSENT = 'web_map_tiles_consent'
const SOURCE = 'map_tile_source'
const API_KEY = 'maptiler_api_key'
/** Longest MapTiler key accepted (real keys are a few dozen characters). */
const MAX_KEY_LENGTH = 1024
/** Longest stored ciphertext hex opened: the key's hex plus generous envelope overhead. */
const MAX_SEALED_HEX_LENGTH = 4096
const HEX = /^(?:[0-9a-f]{2})+$/

export interface WebSettingsEnv {
  openDb: () => Promise<Pick<WebDb, 'meta'>>
  loadCore: () => Promise<Pick<Core, 'sealOutboxMedia' | 'openMedia'>>
  /** Throws `VaultLockedError` when locked. */
  getKeyRing: () => KeyRing
}

let injected: Partial<WebSettingsEnv> = {}
let dbPromise: Promise<Pick<WebDb, 'meta'>> | null = null

const env = (): WebSettingsEnv => ({
  openDb: () => openWebDb(),
  loadCore,
  getKeyRing,
  ...injected,
})

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureWebSettingsEnv(partial: Partial<WebSettingsEnv>): void {
  injected = partial
  dbPromise = null
}

function getDb(): Promise<Pick<WebDb, 'meta'>> {
  dbPromise ??= env()
    .openDb()
    .catch((error: unknown) => {
      dbPromise = null
      throw error
    })
  return dbPromise
}

export const isWebSetting = (key: string): key is WebSettingKey =>
  (WEB_SETTING_KEYS as readonly string[]).includes(key)

const metaKey = (key: WebSettingKey): string => `${WEB_SETTING_PREFIX}${key}`

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** The MapTiler key, or null when the stored ciphertext is malformed or no longer opens. */
async function openKey(stored: unknown): Promise<string | null> {
  if (typeof stored !== 'string' || stored.length > MAX_SEALED_HEX_LENGTH || !HEX.test(stored)) {
    return null
  }
  const core = await env().loadCore()
  const ring = env().getKeyRing()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(core.openMedia(ring, fromHex(stored)))
  } catch {
    return null
  }
}

export async function getWebSetting(key: WebSettingKey): Promise<string | null> {
  env().getKeyRing()
  const value = (await (await getDb()).meta.get(metaKey(key)))?.value
  env().getKeyRing()
  if (key === API_KEY) return openKey(value)
  if (key === CONSENT) return value === '1' ? '1' : null
  if (value !== 'maptiler') return null
  // Tiles reveal the viewed area and the IP to MapTiler: no source without stored consent.
  const consent = (await (await getDb()).meta.get(metaKey(CONSENT)))?.value
  env().getKeyRing()
  return consent === '1' ? 'maptiler' : null
}

export async function deleteWebSetting(key: WebSettingKey): Promise<void> {
  env().getKeyRing()
  const db = await getDb()
  if (key === CONSENT) await db.meta.delete(metaKey(SOURCE))
  await db.meta.delete(metaKey(key))
}

export async function setWebSetting(key: WebSettingKey, value: string): Promise<void> {
  env().getKeyRing()
  if (key === CONSENT) {
    if (value === '0') return deleteWebSetting(CONSENT)
    if (value !== '1') throw new TypeError(`${CONSENT} must be "1" or "0"`)
    await (await getDb()).meta.put({ key: metaKey(CONSENT), value })
    return
  }
  if (key === SOURCE) {
    if (value === '') return deleteWebSetting(SOURCE)
    if (value !== 'maptiler') throw new TypeError(`${SOURCE} on the web must be "maptiler"`)
    await (await getDb()).meta.put({ key: metaKey(SOURCE), value })
    return
  }
  if (value === '') return deleteWebSetting(API_KEY)
  if (value.length > MAX_KEY_LENGTH) throw new TypeError(`${API_KEY} is too long`)
  const core = await env().loadCore()
  const sealed = core.sealOutboxMedia(env().getKeyRing(), new TextEncoder().encode(value))
  await (await getDb()).meta.put({ key: metaKey(API_KEY), value: toHex(sealed) })
}
