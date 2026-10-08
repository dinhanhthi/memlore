import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VaultLockedError } from '../keys'
import { WEB_SETTING_PREFIX, openWebDb, type WebDb } from '../storage/idb'
import {
  WEB_SETTING_KEYS,
  configureWebSettingsEnv,
  deleteWebSetting,
  getWebSetting,
  isWebSetting,
  setWebSetting,
} from './webSettings'

const KEY = 'maptiler_api_key'
const SECRET = 'pk-SECRET-maptiler-0123'
const SEAL_MAGIC = 0x02

let factory: IDBFactory
let db: WebDb
let locked: boolean
let openFails: boolean

/** Reversible stand-in for the WASM envelope: a magic byte, then the bytes reversed. */
const fakeCore = {
  sealOutboxMedia: (_ring: unknown, plain: Uint8Array): Uint8Array =>
    Uint8Array.from([SEAL_MAGIC, ...[...plain].reverse()]),
  openMedia: (_ring: unknown, bytes: Uint8Array): Uint8Array => {
    if (openFails || bytes[0] !== SEAL_MAGIC) throw new Error('envelope: wrong key')
    return Uint8Array.from([...bytes.subarray(1)].reverse())
  },
}

function wire(): void {
  configureWebSettingsEnv({
    openDb: () => Promise.resolve(db),
    loadCore: () => Promise.resolve(fakeCore),
    getKeyRing: () => {
      if (locked) throw new VaultLockedError()
      return {} as never
    },
  })
}

beforeEach(async () => {
  factory = new IDBFactory()
  db = await openWebDb({ factory })
  locked = false
  openFails = false
  wire()
})

afterEach(() => {
  configureWebSettingsEnv({})
})

describe('isWebSetting', () => {
  it('names exactly the three persisted map settings', () => {
    expect([...WEB_SETTING_KEYS].sort()).toEqual([
      'map_tile_source',
      'maptiler_api_key',
      'web_map_tiles_consent',
    ])
    expect(isWebSetting('map_tile_source')).toBe(true)
    expect(isWebSetting('theme')).toBe(false)
    expect(isWebSetting('__proto__')).toBe(false)
  })
})

describe('maptiler_api_key', () => {
  it('round-trips through the sealed envelope', async () => {
    await setWebSetting(KEY, SECRET)
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })

  it('never stores the plaintext key in IndexedDB', async () => {
    await setWebSetting(KEY, SECRET)
    const records = await db.meta.listByPrefix('')
    expect(records).toHaveLength(1)
    expect(records[0].key).toBe(`${WEB_SETTING_PREFIX}${KEY}`)
    expect(JSON.stringify(records)).not.toContain(SECRET)
    expect(JSON.stringify(records)).not.toContain('SECRET')
  })

  it('reads an unopenable ciphertext (key rotation, re-onboard) as absent', async () => {
    await setWebSetting(KEY, SECRET)
    openFails = true
    expect(await getWebSetting(KEY)).toBeNull()
  })

  it('reads a malformed stored value as absent', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${KEY}`, value: 'not hex !!' })
    expect(await getWebSetting(KEY)).toBeNull()
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${KEY}`, value: 42 })
    expect(await getWebSetting(KEY)).toBeNull()
  })

  it('reads an oversized stored hex as absent without opening it', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}${KEY}`, value: '02'.repeat(2049) })
    expect(await getWebSetting(KEY)).toBeNull()
  })

  it('an empty key deletes it; delete removes it', async () => {
    await setWebSetting(KEY, SECRET)
    await setWebSetting(KEY, '')
    expect(await getWebSetting(KEY)).toBeNull()
    await setWebSetting(KEY, SECRET)
    await deleteWebSetting(KEY)
    expect(await getWebSetting(KEY)).toBeNull()
  })
})

describe('consent and tile source', () => {
  it('persist across a simulated reload (a new connection to the same database)', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    await setWebSetting('map_tile_source', 'maptiler')
    await setWebSetting(KEY, SECRET)
    db.close()
    db = await openWebDb({ factory })
    wire()
    expect(await getWebSetting('web_map_tiles_consent')).toBe('1')
    expect(await getWebSetting('map_tile_source')).toBe('maptiler')
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })

  it('reads the tile source as unset unless consent is stored', async () => {
    await setWebSetting('map_tile_source', 'maptiler')
    expect(await getWebSetting('map_tile_source')).toBeNull()
    await setWebSetting('web_map_tiles_consent', '1')
    expect(await getWebSetting('map_tile_source')).toBe('maptiler')
  })

  it('revoking consent clears consent and the tile source but keeps the key', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    await setWebSetting('map_tile_source', 'maptiler')
    await setWebSetting(KEY, SECRET)
    await setWebSetting('web_map_tiles_consent', '0')
    expect(await getWebSetting('web_map_tiles_consent')).toBeNull()
    expect(await getWebSetting('map_tile_source')).toBeNull()
    expect(await getWebSetting(KEY)).toBe(SECRET)
  })

  it('deleting consent revokes it the same way', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    await setWebSetting('map_tile_source', 'maptiler')
    await deleteWebSetting('web_map_tiles_consent')
    expect(await getWebSetting('map_tile_source')).toBeNull()
  })

  it('an empty tile source unsets it (clearMapTileSource)', async () => {
    await setWebSetting('map_tile_source', 'maptiler')
    await setWebSetting('map_tile_source', '')
    expect(await getWebSetting('map_tile_source')).toBeNull()
  })

  it('refuses values the web cannot honour', async () => {
    await expect(setWebSetting('web_map_tiles_consent', 'yes')).rejects.toThrow(TypeError)
    await expect(setWebSetting('map_tile_source', 'offline')).rejects.toThrow(TypeError)
    await expect(setWebSetting('map_tile_source', 'mapkit')).rejects.toThrow(TypeError)
    await expect(setWebSetting(KEY, 'x'.repeat(1025))).rejects.toThrow(TypeError)
    expect(await db.meta.listByPrefix('')).toEqual([])
  })

  it('reads an unexpected stored value as unset', async () => {
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}map_tile_source`, value: 'offline' })
    await db.meta.put({ key: `${WEB_SETTING_PREFIX}web_map_tiles_consent`, value: true })
    expect(await getWebSetting('map_tile_source')).toBeNull()
    expect(await getWebSetting('web_map_tiles_consent')).toBeNull()
  })
})

describe('locked vault', () => {
  it('refuses reads, writes and deletes and touches nothing', async () => {
    await setWebSetting('web_map_tiles_consent', '1')
    locked = true
    for (const key of WEB_SETTING_KEYS) {
      await expect(getWebSetting(key)).rejects.toBeInstanceOf(VaultLockedError)
      await expect(setWebSetting(key, '1')).rejects.toBeInstanceOf(VaultLockedError)
      await expect(deleteWebSetting(key)).rejects.toBeInstanceOf(VaultLockedError)
    }
    locked = false
    expect(await getWebSetting('web_map_tiles_consent')).toBe('1')
  })
})
