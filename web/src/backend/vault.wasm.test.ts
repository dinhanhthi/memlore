import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCore, type Core } from '../core/core'
import { DriveReader, DriveWriter } from './drive/client'
import {
  FakeDrive,
  fakeLocks,
  loadDesktopFixture,
  seedFromFixture,
  violations,
  type DesktopFixture,
} from './drive/fakeDrive'
import { configureKeysEnv, dispose, getKeyRing, isUnlocked, lock, onLock } from './keys'
import { openWebDb, DB_NAME } from './storage/idb'
import { onboardComplete } from './sync/onboard'
import { clearReonboardReason, createPuller, type Puller } from './sync/pull'
import { EntryUnavailableError, createVault, type Vault } from './vault'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'

interface ExpectedEntry {
  entry_id: string
  title: string
  content_text: string
  emotion: string | null
  is_favorite: boolean
  is_locked: boolean
  journal_name: string
  tags: string[]
}

let core: Core
let fixture: DesktopFixture
const expectedEntries = (): ExpectedEntry[] => fixture.expected.entries as ExpectedEntry[]

interface Env {
  idb: IDBFactory
  puller: Puller
  vault: Vault
}

async function setup(): Promise<Env> {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture)
  const deps = {
    getToken: async () => 'tok',
    fetchImpl: (input: string, init?: RequestInit) => drive.fetch(input, init),
    sleep: async () => {},
    locks: fakeLocks(drive),
  }
  const reader = new DriveReader(deps)
  const writer = new DriveWriter(reader, deps)
  const idb = new IDBFactory()
  const db = await openWebDb({ factory: idb })
  await onboardComplete(
    {
      reader,
      writer,
      db,
      core,
      now: () => 1_800_000_000_000,
      randomUUID: () => OWN_ID,
      userAgent: () => 'Chrome/126.0',
      persist: async () => true,
      sleep: async () => {},
    },
    { phrase: fixture.recovery_phrase, password: PASSWORD },
  )
  const puller = createPuller({ reader, db, core, now: () => 1_800_000_000_000 })
  await puller.refresh()
  const vault = createVault({
    core,
    keys: { getKeyRing, onLock },
    puller,
  })
  return { idb, puller, vault }
}

const allIds = (): string[] => expectedEntries().map((e) => e.entry_id)
const expectedOf = (id: string) => {
  const found = expectedEntries().find((e) => e.entry_id === id)
  if (!found) throw new Error(`no fixture entry ${id}`)
  return found
}

/** Every record of every IndexedDB store as text (ciphertext bytes rendered as latin1). */
async function dumpIdb(idb: IDBFactory): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const names = [...db.objectStoreNames]
  const parts: string[] = []
  for (const name of names) {
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction(name, 'readonly').objectStore(name).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    parts.push(
      JSON.stringify(rows, (_k, v: unknown) =>
        v instanceof Uint8Array ? String.fromCharCode(...v) : v,
      ),
    )
  }
  db.close()
  return parts.join('\n')
}

beforeAll(async () => {
  core = await loadCore()
  fixture = loadDesktopFixture()
})

beforeEach(() => {
  violations.length = 0
  clearReonboardReason()
  configureKeysEnv({
    setTimeout: () => 0,
    clearTimeout: () => {},
    emit: () => {},
    document: null,
    window: null,
  })
})

afterEach(() => {
  dispose()
  vi.restoreAllMocks()
  expect(violations).toEqual([])
})

describe('vault with the desktop fixture', () => {
  it('opens every non-locked entry with its real title, body, emotion and favorite flag', async () => {
    const { vault } = await setup()
    const result = await vault.load(allIds())
    const locked = expectedEntries()
      .filter((e) => e.is_locked)
      .map((e) => e.entry_id)
    expect(locked).toHaveLength(1)
    expect(result.excluded).toEqual(locked)
    expect(result.failed).toEqual([])
    expect(vault.size).toBe(6)
    for (const exp of expectedEntries().filter((e) => !e.is_locked)) {
      const entry = vault.getEntry(exp.entry_id)
      expect(entry.metadata.title).toBe(exp.title)
      expect(entry.contentText).toBe(exp.content_text)
      expect(entry.metadata.emotion).toBe(exp.emotion)
      expect(entry.metadata.is_favorite).toBe(exp.is_favorite)
      expect(entry.metadata.journal_name).toBe(exp.journal_name)
      expect(entry.metadata.tag_ids).toHaveLength(exp.tags.length)
    }
    expect(vault.getContentBytes(allIds()[0]).length).toBeGreaterThan(0)
    expect(vault.listFavorites().map((e) => e.metadata.title)).toEqual(['Golden two'])
  })

  it('searches the Vietnamese entry accent-insensitively', async () => {
    const { vault } = await setup()
    await vault.load(allIds())
    expect(vault.search('ban ghi thu nam').map((e) => e.metadata.title)).toEqual(['Golden five'])
    expect(vault.search('đây').map((e) => e.metadata.title)).toEqual(['Golden five'])
    expect(vault.search('golden', { prefix: true })).toHaveLength(6)
  })

  it('excludes the locked entry everywhere and never retains its plaintext', async () => {
    const { vault } = await setup()
    await vault.load(allIds())
    const exp = expectedEntries().find((e) => e.is_locked)
    if (!exp) throw new Error('no locked entry')
    expect(vault.status(exp.entry_id)).toBe('locked')
    expect(() => vault.getEntry(exp.entry_id)).toThrow(EntryUnavailableError)
    expect(() => vault.getContentBytes(exp.entry_id)).toThrow(EntryUnavailableError)
    expect(vault.listLoaded().map((e) => e.metadata.entry_id)).not.toContain(exp.entry_id)
    expect(vault.search('sixth')).toEqual([])
    expect(vault.listIndex().map((e) => e.entryId)).not.toContain(exp.entry_id)
    const dump = vault.__debugDump()
    expect(dump).not.toContain(exp.title)
    expect(dump).not.toContain(exp.content_text)
  })

  it('writes no plaintext to IndexedDB, web storage or the console', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const info = vi.spyOn(console, 'info')
    const { vault, idb } = await setup()
    await vault.load(allIds())
    vault.search('golden', { prefix: true })
    const markers = expectedEntries().flatMap((e) => [e.title, e.content_text])
    const stored = await dumpIdb(idb)
    expect(stored.length).toBeGreaterThan(0)
    for (const marker of markers) expect(stored).not.toContain(marker)
    for (const spy of [log, warn, error, info]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('Golden')
    }
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      const area = (globalThis as { [k: string]: unknown })[name] as Storage | undefined
      if (area === undefined) continue
      const text = JSON.stringify({ ...area })
      for (const marker of markers) expect(text).not.toContain(marker)
    }
  })

  it('wipes the vault on a real lock', async () => {
    const { vault } = await setup()
    await vault.load(allIds())
    expect(vault.size).toBe(6)
    expect(isUnlocked()).toBe(true)
    lock('manual')
    expect(vault.size).toBe(0)
    expect(() => vault.getEntry(allIds()[0])).toThrow(EntryUnavailableError)
    expect(JSON.parse(vault.__debugDump())).toEqual({ entries: [], stubs: [] })
    await expect(vault.load(allIds())).rejects.toThrow('vault is locked')
  })
})

describe('cross-device LWW with the real WASM merge', () => {
  /** Opens fixture payloads for real, then lets a test rewrite the metadata of the next open. */
  async function setupWithTweak() {
    let tweak: ((m: Record<string, unknown>) => void) | null = null
    const wrapped = {
      mergeMetadataLww: core.mergeMetadataLww,
      openEntry: (...args: Parameters<Core['openEntry']>) => {
        const opened = core.openEntry(...args)
        if (tweak === null) return opened
        const meta = JSON.parse(opened.metadataJson) as Record<string, unknown>
        tweak(meta)
        return { metadataJson: JSON.stringify(meta), yjs: opened.yjs } as typeof opened
      },
    }
    const index = new Map<
      string,
      { entryId: string; authorDevice: string; updatedAt: number; isDeleted: boolean }
    >()
    const env = await setup()
    for (const [id, row] of env.puller.index ?? new Map()) index.set(id, row)
    const vault = createVault({
      core: wrapped,
      keys: { getKeyRing, onLock },
      puller: {
        fetchEntries: (ids) => env.puller.fetchEntries(ids),
        dropCached: (ids) => env.puller.dropCached(ids),
        index,
      },
    })
    return { vault, index, setTweak: (t: typeof tweak) => (tweak = t) }
  }

  it('takes the newer device copy and ignores an older one', async () => {
    const { vault, index, setTweak } = await setupWithTweak()
    const id = allIds()[1]
    await vault.load([id])
    const base = vault.getEntry(id).metadata
    const row = index.get(id)
    if (!row) throw new Error('not indexed')

    setTweak((m) => {
      m.device_id = 'zzzz-laptop'
      m.updated_at = base.updated_at + 50
      m.title = 'Edited on the laptop'
    })
    index.set(id, { ...row, updatedAt: base.updated_at + 50 })
    await vault.load([id])
    expect(vault.getEntry(id).metadata).toMatchObject({
      title: 'Edited on the laptop',
      device_id: 'zzzz-laptop',
    })

    setTweak((m) => {
      m.device_id = 'aaaa-old'
      m.updated_at = base.updated_at - 50
      m.title = 'Stale copy'
    })
    index.set(id, { ...row, updatedAt: base.updated_at + 80 })
    await vault.load([id])
    expect(vault.getEntry(id).metadata.title).toBe('Edited on the laptop')
  })

  it('a newer copy that became locked drops the content it replaced', async () => {
    const { vault, index, setTweak } = await setupWithTweak()
    const id = allIds()[2]
    await vault.load([id])
    const base = vault.getEntry(id).metadata
    const row = index.get(id)
    if (!row) throw new Error('not indexed')
    setTweak((m) => {
      m.updated_at = base.updated_at + 10
      m.is_locked = true
    })
    index.set(id, { ...row, updatedAt: base.updated_at + 10 })
    await vault.load([id])
    expect(vault.status(id)).toBe('locked')
    expect(vault.__debugDump()).not.toContain(expectedOf(id).title)
  })
})
