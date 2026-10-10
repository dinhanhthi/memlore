import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { extractPlainText } from '../../../src/lib/yjs'
import type { KeyRing } from './keys'
import { VaultLockedError } from './keys'
import type { IndexEntry } from './sync/entryIndex'
import type { OutboxEntryV1 } from './sync/outbox'
import {
  EntryUnavailableError,
  ForeignEntryReadOnlyError,
  createVault,
  type EntryMetadata,
  type VaultSource,
} from './vault'

const enc = new TextEncoder()

interface Fake {
  vault: ReturnType<typeof createVault>
  /** Registers a payload; the "ciphertext" is just the entry id. */
  put: (meta: Partial<EntryMetadata> & { entry_id: string }, yjs?: string | Uint8Array) => void
  index: Map<string, IndexEntry>
  fetched: string[]
  /** Registers a copy served from the "cache" before the Drive copy, until `dropCached`. */
  cache: (meta: Partial<EntryMetadata> & { entry_id: string }) => void
  dropped: string[]
  lock: () => void
  hooks: Array<() => void>
  unlockState: { locked: boolean }
  mergeSpy: ReturnType<typeof vi.fn>
}

function setup(guardMetadata?: (id: string, metadataJson: string) => void): Fake {
  const payloads = new Map<string, { metadataJson: string; yjs: Uint8Array }>()
  const index = new Map<string, IndexEntry>()
  const fetched: string[] = []
  const cached = new Map<string, { metadataJson: string; yjs: Uint8Array }>()
  const dropped: string[] = []
  const hooks: Array<() => void> = []
  const unlockState = { locked: false }
  const mergeSpy = vi.fn((a: string, b: string): string => {
    const x = JSON.parse(a) as EntryMetadata
    const y = JSON.parse(b) as EntryMetadata
    if (x.updated_at !== y.updated_at) return x.updated_at > y.updated_at ? a : b
    return y.device_id > x.device_id ? b : a
  })
  const puller: VaultSource = {
    index,
    fetchEntries: async (ids) => {
      fetched.push(...ids)
      return new Map(
        ids
          .filter((id) => cached.has(id) || payloads.has(id))
          .map((id) => [id, enc.encode(cached.has(id) ? `cached:${id}` : id)]),
      )
    },
    dropCached: async (ids) => {
      dropped.push(...ids)
      for (const id of ids) cached.delete(id)
    },
  }
  const vault = createVault({
    core: {
      openEntry: (_ring: KeyRing, bytes: Uint8Array) => {
        const key = new TextDecoder().decode(bytes)
        const found = key.startsWith('cached:')
          ? cached.get(key.slice('cached:'.length))
          : payloads.get(key)
        if (found === undefined) throw new Error('cannot open')
        return found as never
      },
      mergeMetadataLww: mergeSpy,
    },
    keys: {
      getKeyRing: () => {
        if (unlockState.locked) throw new VaultLockedError()
        return {} as KeyRing
      },
      onLock: (cb) => {
        hooks.push(cb)
        return () => {}
      },
    },
    puller,
    now: () => 1234,
    guardMetadata,
  })
  const fullOf = (meta: Partial<EntryMetadata> & { entry_id: string }): EntryMetadata => ({
    device_id: 'dev-a',
    updated_at: 100,
    entry_date: 1000,
    created_at: 1000,
    journal_id: 'j1',
    journal_name: 'Journal',
    title: 'Title',
    preview_text: 'preview',
    content_text: 'body',
    emotion: null,
    is_favorite: false,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    tag_ids: [],
    ...meta,
  })
  const put: Fake['put'] = (meta, yjs = 'yjs') => {
    const full = fullOf(meta)
    payloads.set(full.entry_id, {
      metadataJson: JSON.stringify(full),
      yjs: typeof yjs === 'string' ? enc.encode(yjs) : yjs,
    })
    index.set(full.entry_id, {
      entryId: full.entry_id,
      authorDevice: full.device_id,
      updatedAt: full.updated_at,
      isDeleted: full.is_deleted,
      ...(typeof full.trashed_at === 'number' ? { trashedAt: full.trashed_at } : {}),
    })
  }
  return {
    vault,
    put,
    index,
    fetched,
    cache: (meta) => {
      cached.set(meta.entry_id, {
        metadataJson: JSON.stringify(fullOf(meta)),
        yjs: enc.encode('old'),
      })
    },
    dropped,
    hooks,
    unlockState,
    mergeSpy,
    lock: () => {
      unlockState.locked = true
      for (const hook of hooks) hook()
    },
  }
}

describe('read-side format guard', () => {
  it('runs the metadata guard on every opened copy and still shows the entry', async () => {
    const guard = vi.fn()
    const f = setup(guard)
    f.put({ entry_id: 'b', title: 'newer', future_field: 1 })
    const result = await f.vault.load(['b'])
    expect(result.loaded).toEqual(['b'])
    expect(f.vault.getEntry('b').metadata.title).toBe('newer')
    expect(guard).toHaveBeenCalledTimes(1)
    const [id, json] = guard.mock.calls[0] as [string, string]
    expect(id).toBe('b')
    expect(JSON.parse(json)).toMatchObject({ entry_id: 'b', future_field: 1 })
  })
})

describe('load and views', () => {
  it('opens payloads and lists them by entry date, newest first', async () => {
    const f = setup()
    f.put({ entry_id: 'a', entry_date: 10, title: 'old' })
    f.put({ entry_id: 'b', entry_date: 30, title: 'new', is_favorite: true, tag_ids: ['t1'] })
    f.put({ entry_id: 'c', entry_date: 20, title: 'mid', tag_ids: ['t1', 't2'], emotion: 'good' })
    const result = await f.vault.load(['a', 'b', 'c'])
    expect(result.loaded.sort()).toEqual(['a', 'b', 'c'])
    expect(f.vault.size).toBe(3)
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['b', 'c', 'a'])
    expect(f.vault.listFavorites().map((e) => e.metadata.entry_id)).toEqual(['b'])
    expect(f.vault.count({ tagId: 't1' })).toBe(2)
    expect(f.vault.tagCounts().get('t2')).toBe(1)
    expect(f.vault.journalCounts().get('j1')).toBe(3)
    expect(f.vault.listLoaded({ emotion: 'good' })).toHaveLength(1)
    expect(f.vault.getEntry('b')).toMatchObject({ contentText: 'body', previewText: 'preview' })
    expect(new TextDecoder().decode(f.vault.getContentBytes('b'))).toBe('yjs')
    expect(f.vault.isLoaded('a')).toBe(true)
  })

  it('does not refetch a fresh entry but refetches when the index moved on', async () => {
    const f = setup()
    f.put({ entry_id: 'a' })
    await f.vault.load(['a'])
    await f.vault.load(['a'])
    expect(f.fetched).toEqual(['a'])
    f.put({ entry_id: 'a', updated_at: 200, title: 'edited' })
    await f.vault.load(['a'])
    expect(f.fetched).toEqual(['a', 'a'])
    expect(f.vault.getEntry('a').metadata.title).toBe('edited')
  })

  it('drops a cached copy older than the index winner and refetches it once', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 200, title: 'fresh' })
    f.cache({ entry_id: 'a', updated_at: 100, title: 'stale' })
    const result = await f.vault.load(['a'])
    expect(f.fetched).toEqual(['a', 'a'])
    expect(f.dropped).toEqual(['a'])
    expect(f.vault.getEntry('a').metadata).toMatchObject({ title: 'fresh', updated_at: 200 })
    expect(result).toMatchObject({ loaded: ['a'], stale: [] })
    await f.vault.load(['a'])
    expect(f.fetched).toEqual(['a', 'a']) // fresh now: no more fetches
  })

  it('reports a copy still older than the winner after one refetch, and retries on the next load', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'old' })
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-a', updatedAt: 200, isDeleted: false })
    const result = await f.vault.load(['a'])
    expect(f.fetched).toEqual(['a', 'a'])
    expect(result).toMatchObject({ loaded: ['a'], stale: ['a'] })
    expect(f.vault.getEntry('a').metadata.title).toBe('old') // the best copy obtainable
    await f.vault.load(['a'])
    expect(f.fetched).toEqual(['a', 'a', 'a', 'a'])
  })

  it('an older refetched copy never replaces a newer one already held', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 300, title: 'newest' })
    await f.vault.load(['a'])
    f.put({ entry_id: 'a', updated_at: 100, title: 'rolled back' })
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-a', updatedAt: 400, isDeleted: false })
    const result = await f.vault.load(['a'])
    expect(f.vault.getEntry('a').metadata.title).toBe('newest')
    expect(result).toMatchObject({ loaded: ['a'], stale: ['a'] })
  })

  it('reports unknown ids as missing and corrupt payloads as failed', async () => {
    const f = setup()
    f.put({ entry_id: 'a' })
    f.index.set('ghost', { entryId: 'ghost', authorDevice: 'd', updatedAt: 1, isDeleted: false })
    const result = await f.vault.load(['a', 'nope', 'ghost'])
    expect(result.missing.sort()).toEqual(['ghost', 'nope'])
    expect(result.loaded).toEqual(['a'])
  })

  it('folds Vietnamese in search and treats the last token as prefix on request', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: 'Chuyến đi Hà Nội', content_text: 'Hôm nay trời đẹp' })
    f.put({ entry_id: 'b', title: 'Other', content_text: 'nothing here' })
    await f.vault.load(['a', 'b'])
    expect(f.vault.search('troi DEP').map((e) => e.metadata.entry_id)).toEqual(['a'])
    expect(f.vault.search('ha noi').map((e) => e.metadata.entry_id)).toEqual(['a'])
    expect(f.vault.search('tro')).toEqual([])
    expect(f.vault.search('tro', { prefix: true })).toHaveLength(1)
    expect(f.vault.search('   ')).toEqual([])
  })

  it('lists the index by updated_at desc without tombstones', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 1 })
    f.put({ entry_id: 'b', updated_at: 3 })
    f.put({ entry_id: 'c', updated_at: 2, is_deleted: true })
    expect(f.vault.listIndex().map((e) => e.entryId)).toEqual(['b', 'a'])
  })
})

describe('exclusions', () => {
  const SECRET = 'SECRET-MARKER-xyz'

  it('excludes locked, invisible and deleted entries from every view and keeps no plaintext', async () => {
    const f = setup()
    f.put({ entry_id: 'ok', title: 'fine', tag_ids: ['t'], is_favorite: true })
    f.put(
      {
        entry_id: 'locked',
        title: SECRET,
        content_text: SECRET,
        preview_text: SECRET,
        is_locked: true,
        is_favorite: true,
        tag_ids: ['t'],
        journal_id: 'jl',
      },
      SECRET,
    )
    f.put(
      {
        entry_id: 'invis',
        title: SECRET,
        content_text: SECRET,
        is_invisible: true,
        tag_ids: ['t'],
      },
      SECRET,
    )
    f.put({ entry_id: 'gone', title: SECRET, content_text: SECRET, is_deleted: true }, SECRET)
    const result = await f.vault.load(['ok', 'locked', 'invis', 'gone'])
    expect(result.loaded).toEqual(['ok'])
    expect(result.excluded.sort()).toEqual(['gone', 'invis', 'locked'])
    expect(f.vault.size).toBe(1)
    expect(f.vault.count()).toBe(1)
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['ok'])
    expect(f.vault.listFavorites().map((e) => e.metadata.entry_id)).toEqual(['ok'])
    expect(f.vault.search('secret')).toEqual([])
    expect(f.vault.search('secret', { prefix: true })).toEqual([])
    expect(f.vault.tagCounts().get('t')).toBe(1)
    expect([...f.vault.journalCounts().keys()]).toEqual(['j1'])
    expect(f.vault.listIndex().map((e) => e.entryId)).toEqual(['ok'])
    expect(f.vault.status('locked')).toBe('locked')
    expect(f.vault.status('invis')).toBe('invisible')
    expect(f.vault.status('gone')).toBe('deleted')
    for (const id of ['locked', 'invis', 'gone']) {
      expect(() => f.vault.getEntry(id)).toThrow(EntryUnavailableError)
      expect(() => f.vault.getContentBytes(id)).toThrow(EntryUnavailableError)
    }
    expect(f.vault.__debugDump()).not.toContain(SECRET)
    expect(f.vault.__debugDump().toLowerCase()).not.toContain('secret')
  })

  it('does not fetch an entry the index already marks deleted, and drops a loaded copy', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: SECRET })
    await f.vault.load(['a'])
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-a', updatedAt: 500, isDeleted: true })
    const result = await f.vault.load(['a'])
    expect(result.excluded).toEqual(['a'])
    expect(f.fetched).toEqual(['a'])
    expect(f.vault.size).toBe(0)
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('treats a trashed index winner as deleted, even when a live copy at the same time is held', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: SECRET, updated_at: 500 })
    f.put({ entry_id: 'b', updated_at: 400 })
    await f.vault.load(['a', 'b'])
    // An old peer re-lists the entry live at the same updated_at; the trashed row wins the tie.
    f.index.set('a', {
      entryId: 'a',
      authorDevice: 'dev-z',
      updatedAt: 500,
      isDeleted: false,
      trashedAt: 450,
    })
    const result = await f.vault.load(['a'])
    expect(result.excluded).toEqual(['a'])
    expect(f.vault.status('a')).toBe('deleted')
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['b'])
    expect(f.vault.search('title')).toHaveLength(1)
    expect(f.vault.listIndex().map((e) => e.entryId)).toEqual(['b'])
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('hides an opened copy whose metadata is trashed; ignores a non-numeric trashed_at', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: SECRET, trashed_at: 450 })
    f.put({ entry_id: 'b', title: 'fine', trashed_at: '450' as never })
    // The manifest row did not say so (e.g. an older cached manifest): the payload decides.
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-a', updatedAt: 100, isDeleted: false })
    const result = await f.vault.load(['a', 'b'])
    expect(result.excluded).toEqual(['a'])
    expect(result.loaded).toEqual(['b'])
    expect(f.vault.status('a')).toBe('deleted')
    expect(f.vault.search('fine').map((e) => e.metadata.entry_id)).toEqual(['b'])
    expect(f.vault.getEntry('b').metadata).not.toHaveProperty('trashed_at')
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('hides an entry with a pending web trash from every view, keeps its synced state, and shows it again once cleared', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: 'alpha', updated_at: 300 })
    f.put({ entry_id: 'b', title: 'beta', updated_at: 200 })
    await f.vault.load(['a', 'b'])
    f.vault.setOutboxIntents([
      {
        schema_version: 1,
        entry_id: 'w',
        web_device_id: 'web-1',
        created_on_web: true,
        web_updated_at_secs: 400,
        base_state_vector: [],
        yjs_full_state: [],
        content_text: 'web body',
        preview_text: null,
        fields: {
          title: {
            value: 'web',
            base: '',
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 400,
          },
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: null,
          tags_add: {},
          tags_remove: {},
        },
        media: [],
      },
    ])

    f.vault.setTrashedIds(['a', 'w'])

    expect(f.vault.status('a')).toBe('deleted')
    expect(f.vault.status('w')).toBe('deleted')
    expect(() => f.vault.getEntry('a')).toThrow(EntryUnavailableError)
    expect(() => f.vault.getWriteView('a')).toThrow(EntryUnavailableError)
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['b'])
    expect(f.vault.search('alpha')).toEqual([])
    expect(f.vault.listIndex().map((e) => e.entryId)).toEqual(['b'])
    // Retention compares against the synced copy, never the overlay.
    expect(f.vault.getSynced('a')).toMatchObject({
      status: 'visible',
      metadata: { updated_at: 300 },
    })

    f.vault.setTrashedIds([])
    expect(f.vault.getEntry('a').metadata.title).toBe('alpha')
    expect(
      f.vault
        .listLoaded()
        .map((e) => e.metadata.entry_id)
        .sort(),
    ).toEqual(['a', 'b', 'w'])
  })

  it('forgets the pending trash set on lock', async () => {
    const f = setup()
    f.vault.setTrashedIds(['a'])
    f.lock()
    f.unlockState.locked = false
    f.put({ entry_id: 'a' })
    await f.vault.load(['a'])
    expect(f.vault.status('a')).toBe('visible')
  })

  it('reduces entries of an excluded journal to stubs, now and on later loads', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: SECRET, journal_id: 'secret-j' })
    f.put({ entry_id: 'b', title: 'fine', journal_id: 'j1' })
    await f.vault.load(['a', 'b'])
    f.vault.setExcludedJournalIds(['secret-j'])
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['b'])
    expect(f.vault.status('a')).toBe('journal')
    expect(f.vault.__debugDump()).not.toContain(SECRET)
    f.put({ entry_id: 'c', title: SECRET, journal_id: 'secret-j' })
    expect((await f.vault.load(['c'])).excluded).toEqual(['c'])
    expect(f.vault.__debugDump()).not.toContain(SECRET)
    // the journal becomes visible again: its entries reload instead of staying stubs
    f.vault.setExcludedJournalIds([])
    expect((await f.vault.load(['a'])).loaded).toEqual(['a'])
  })

  it('hides entries of an unknown journal (fail closed) but never entries without a journal', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: SECRET, journal_id: 'ghost' })
    f.put({ entry_id: 'b', journal_id: 'j1' })
    f.put({ entry_id: 'n', journal_id: '' })
    f.vault.setExcludedJournalIds([], ['j1'])
    const result = await f.vault.load(['a', 'b', 'n'])
    expect(result.loaded.sort()).toEqual(['b', 'n'])
    expect(result.excluded).toEqual(['a'])
    expect(f.vault.__debugDump()).not.toContain(SECRET)
    // the journal record shows up later: the stub is dropped and the entry is listed and loads
    f.vault.setExcludedJournalIds([], ['j1', 'ghost'])
    expect(f.vault.listIndex().map((e) => e.entryId)).toContain('a')
    expect((await f.vault.load(['a'])).loaded).toEqual(['a'])
  })

  it('isJournalExcluded applies the excluded and the unknown-journal rule', () => {
    const f = setup()
    // Fail closed: before the taxonomy is loaded no journal is known to be visible.
    expect(f.vault.isJournalExcluded('j1')).toBe(true)
    expect(f.vault.isJournalExcluded('')).toBe(true)
    f.vault.setExcludedJournalIds(['secret-j'], ['j1', 'secret-j'])
    expect(f.vault.isJournalExcluded('secret-j')).toBe(true)
    expect(f.vault.isJournalExcluded('ghost')).toBe(true)
    expect(f.vault.isJournalExcluded('j1')).toBe(false)
    expect(f.vault.isJournalExcluded('')).toBe(true)
  })

  it('lists a stubbed entry again once the index winner is newer than the stub', async () => {
    const f = setup()
    f.put({ entry_id: 'a', is_locked: true, updated_at: 100 })
    await f.vault.load(['a'])
    expect(f.vault.status('a')).toBe('locked')
    expect(f.vault.listIndex().map((e) => e.entryId)).not.toContain('a')
    f.put({ entry_id: 'a', is_locked: false, updated_at: 200 })
    expect(f.vault.listIndex().map((e) => e.entryId)).toContain('a')
    expect((await f.vault.load(['a'])).loaded).toEqual(['a'])
    expect(f.vault.status('a')).toBe('visible')
  })

  it('treats a missing or non-boolean lock flag as false, never as locked', async () => {
    const f = setup()
    f.put({ entry_id: 'a', is_locked: 'yes' as never, is_invisible: 1 as never })
    expect((await f.vault.load(['a'])).loaded).toEqual(['a'])
  })
})

describe('lock', () => {
  it('wipes the maps when the lock hook runs and getEntry then throws', async () => {
    const f = setup()
    f.put({ entry_id: 'a' })
    f.put({ entry_id: 'l', is_locked: true })
    f.vault.setExcludedJournalIds(['x'])
    await f.vault.load(['a', 'l'])
    expect(f.vault.size).toBe(1)
    expect(f.hooks).toHaveLength(1)
    f.lock()
    expect(f.vault.size).toBe(0)
    expect(f.vault.isLoaded('a')).toBe(false)
    expect(f.vault.status('l')).toBe('not-loaded')
    expect(() => f.vault.getEntry('a')).toThrow(EntryUnavailableError)
    expect(f.vault.listLoaded()).toEqual([])
    expect(JSON.parse(f.vault.__debugDump())).toEqual({ entries: [], stubs: [], trashed: [] })
    await expect(f.vault.load(['a'])).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('discards the result of a load that was in flight when the lock happened', async () => {
    const f = setup()
    f.put({ entry_id: 'a' })
    const pending = f.vault.load(['a'])
    f.hooks[0]()
    const result = await pending
    expect(result.loaded).toEqual([])
    expect(f.vault.size).toBe(0)
  })

  it('dispose clears the maps', async () => {
    const f = setup()
    f.put({ entry_id: 'a' })
    await f.vault.load(['a'])
    f.vault.dispose()
    expect(f.vault.size).toBe(0)
  })
})

describe('cross-device LWW (mocked core merge)', () => {
  it('keeps the newer copy and ignores an older one that arrives later', async () => {
    const f = setup()
    f.put({ entry_id: 'a', device_id: 'dev-a', updated_at: 200, title: 'newer' })
    await f.vault.load(['a'])
    // an older copy of the same entry from another device shows up as the index winner
    f.put({ entry_id: 'a', device_id: 'dev-b', updated_at: 100, title: 'older' })
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-b', updatedAt: 300, isDeleted: false })
    const result = await f.vault.load(['a'])
    // Older than its winner, so it is downloaded again once: both opens merge, neither wins.
    expect(f.mergeSpy).toHaveBeenCalledTimes(2)
    expect(result.stale).toEqual(['a'])
    expect(f.vault.getEntry('a').metadata.title).toBe('newer')
  })

  it('replaces with the newer incoming copy; a tie goes to the greater device id', async () => {
    const f = setup()
    f.put({ entry_id: 'a', device_id: 'dev-a', updated_at: 100, title: 'first' })
    await f.vault.load(['a'])
    f.put({ entry_id: 'a', device_id: 'dev-b', updated_at: 100, title: 'tie-b' })
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-b', updatedAt: 150, isDeleted: false })
    await f.vault.load(['a'])
    expect(f.vault.getEntry('a').metadata.title).toBe('tie-b')
    f.put({ entry_id: 'a', device_id: 'dev-a', updated_at: 100, title: 'tie-a' })
    f.index.set('a', { entryId: 'a', authorDevice: 'dev-a', updatedAt: 160, isDeleted: false })
    await f.vault.load(['a'])
    expect(f.vault.getEntry('a').metadata.title).toBe('tie-b')
  })

  it('a newer locked copy replaces a visible one and drops its content', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'public' })
    await f.vault.load(['a'])
    f.put({ entry_id: 'a', updated_at: 200, title: 'now-private', is_locked: true })
    await f.vault.load(['a'])
    expect(f.vault.status('a')).toBe('locked')
    expect(f.vault.__debugDump()).not.toContain('now-private')
    expect(f.vault.__debugDump()).not.toContain('public')
  })
})

describe('outbox overlay', () => {
  it('reads the text of a draft over a newer desktop copy from the merged doc', async () => {
    const paragraph = (doc: Y.Doc, text: string) => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(text)])
      doc.getXmlFragment('default').push([p])
    }
    const base = new Y.Doc()
    paragraph(base, 'Base')
    const draft = new Y.Doc()
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(base))
    paragraph(draft, 'From web')
    const desktop = new Y.Doc()
    Y.applyUpdate(desktop, Y.encodeStateAsUpdate(base))
    paragraph(desktop, 'From desktop')

    const f = setup()
    f.put(
      { entry_id: 'a', updated_at: 200, content_text: 'Base\nFrom desktop' },
      Y.encodeStateAsUpdate(desktop),
    )
    await f.vault.load(['a'])
    f.vault.setOutboxIntents([
      webIntent('a', {
        created_on_web: false,
        yjs_full_state: Array.from(Y.encodeStateAsUpdate(draft)),
        content_text: 'Base\nFrom web',
        preview_text: 'Base\nFrom web',
      }),
    ])

    const held = f.vault.getEntry('a')
    const merged = new Y.Doc()
    Y.applyUpdate(merged, held.content)
    expect(held.contentText).toBe(extractPlainText(merged))
    expect(held.contentText).toContain('From web')
    expect(held.contentText).toContain('From desktop')
    expect(held.previewText).toBe(held.contentText.slice(0, 150))
    expect(held.metadata.preview_text).toBe(held.previewText)
  })

  it('overlays pending outbox fields on top of synced entry when base matches', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'Base Title' })
    await f.vault.load(['a'])

    f.vault.setOutboxIntents([
      {
        schema_version: 1,
        entry_id: 'a',
        web_device_id: 'web-1',
        created_on_web: false,
        web_updated_at_secs: 150,
        base_state_vector: [],
        yjs_full_state: [],
        content_text: null,
        preview_text: null,
        fields: {
          title: {
            value: 'Web Title',
            base: 'Base Title',
            base_updated_at: 100,
            change_seq: 1,
            changed_at_secs: 150,
          },
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: null,
          tags_add: {},
          tags_remove: {},
        },
        media: [],
      },
    ])

    expect(f.vault.getEntry('a').metadata.title).toBe('Web Title')
  })

  it('never masks a later desktop edit with an older outbox intent', async () => {
    const f = setup()
    // Desktop updated_at is 200, but intent base_updated_at is 100 and base is 'Base Title'
    f.put({ entry_id: 'a', updated_at: 200, title: 'Desktop Newer Title' })
    await f.vault.load(['a'])

    f.vault.setOutboxIntents([
      {
        schema_version: 1,
        entry_id: 'a',
        web_device_id: 'web-1',
        created_on_web: false,
        web_updated_at_secs: 150,
        base_state_vector: [],
        yjs_full_state: [],
        content_text: null,
        preview_text: null,
        fields: {
          title: {
            value: 'Web Title',
            base: 'Base Title',
            base_updated_at: 100,
            change_seq: 1,
            changed_at_secs: 150,
          },
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: null,
          tags_add: {},
          tags_remove: {},
        },
        media: [],
      },
    ])

    // Desktop newer title wins!
    expect(f.vault.getEntry('a').metadata.title).toBe('Desktop Newer Title')
  })

  it('serves outbox-created entry before it appears in synced manifest', () => {
    const f = setup()
    f.vault.setOutboxIntents([
      {
        schema_version: 1,
        entry_id: 'created-web-1',
        web_device_id: 'web-1',
        created_on_web: true,
        web_updated_at_secs: 200,
        base_state_vector: [],
        yjs_full_state: [],
        content_text: 'Created body',
        preview_text: 'Created preview',
        fields: {
          title: {
            value: 'Created Entry',
            base: '',
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 200,
          },
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: null,
          tags_add: {},
          tags_remove: {},
        },
        media: [],
      },
    ])

    expect(f.vault.getEntry('created-web-1').metadata.title).toBe('Created Entry')
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toContain('created-web-1')
  })

  it('hides created_on_web outbox entry when its journal is excluded', () => {
    const f = setup()
    f.vault.setOutboxIntents([
      {
        schema_version: 1,
        entry_id: 'secret-web-1',
        web_device_id: 'web-1',
        created_on_web: true,
        web_updated_at_secs: 200,
        base_state_vector: [],
        yjs_full_state: [],
        content_text: 'Secret body',
        preview_text: 'Secret preview',
        fields: {
          title: {
            value: 'Secret Entry',
            base: '',
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 200,
          },
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: {
            value: 'secret-journal',
            base: '',
            base_updated_at: 0,
            change_seq: 2,
            changed_at_secs: 200,
          },
          tags_add: {},
          tags_remove: {},
        },
        media: [],
      },
    ])

    expect(f.vault.isLoaded('secret-web-1')).toBe(true)
    expect(f.vault.status('secret-web-1')).toBe('visible')

    f.vault.setExcludedJournalIds(['secret-journal'])

    expect(f.vault.isLoaded('secret-web-1')).toBe(false)
    expect(f.vault.status('secret-web-1')).toBe('journal')
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).not.toContain('secret-web-1')
    expect(() => f.vault.getEntry('secret-web-1')).toThrow(EntryUnavailableError)
  })

  it('marks overlaid media with is_outbox: true and tolerates corrupt Yjs full state', async () => {
    const f = setup()
    f.put({ entry_id: 'base-entry', title: 'Base Title' })
    await f.vault.load(['base-entry'])

    f.vault.setOutboxIntents([
      {
        schema_version: 1,
        entry_id: 'base-entry',
        web_device_id: 'web-1',
        created_on_web: false,
        web_updated_at_secs: 300,
        base_state_vector: [],
        yjs_full_state: [99, 99, 99, 99], // invalid Yjs update bytes
        content_text: 'Tolerated content',
        preview_text: 'Tolerated preview',
        fields: {
          title: null,
          entry_date: null,
          emotion: null,
          is_favorite: null,
          journal_id: null,
          tags_add: {},
          tags_remove: {},
        },
        media: [
          {
            media_id: 'm1',
            file_name: 'photo.jpg',
            file_type: 'image/jpeg',
            size: 500,
            has_thumb: true,
          },
        ],
      },
    ])

    const entry = f.vault.getEntry('base-entry')
    expect(entry.metadata.content_text).toBe('Tolerated content')
    const media = entry.metadata.media as Array<{ id: string; is_outbox?: boolean }>
    expect(media[0].id).toBe('m1')
    expect(media[0].is_outbox).toBe(true)
  })
})

function webIntent(
  entryId: string,
  overrides: Omit<Partial<OutboxEntryV1>, 'fields'> & {
    fields?: Partial<OutboxEntryV1['fields']>
  } = {},
): OutboxEntryV1 {
  const { fields, ...rest } = overrides
  return {
    schema_version: 1,
    entry_id: entryId,
    web_device_id: 'web-1',
    created_on_web: true,
    web_updated_at_secs: 200,
    base_state_vector: [],
    yjs_full_state: [],
    content_text: 'Draft body',
    preview_text: 'Draft preview',
    ...rest,
    fields: {
      title: { value: 'Draft', base: '', base_updated_at: 0, change_seq: 1, changed_at_secs: 200 },
      entry_date: null,
      emotion: null,
      is_favorite: null,
      journal_id: null,
      tags_add: {},
      tags_remove: {},
      ...fields,
    },
    media: [],
  }
}

describe('a stub and the overlaid journal win over outbox intents', () => {
  const reasons = [
    ['locked', { is_locked: true }],
    ['invisible', { is_invisible: true }],
    ['deleted', { is_deleted: true }],
  ] as const

  it.each(reasons)(
    'hides a created_on_web draft once desktop made the entry %s',
    async (reason, flags) => {
      const f = setup()
      f.vault.setOutboxIntents([webIntent('w1')])
      f.put({ entry_id: 'w1', updated_at: 300, title: 'Draft', tag_ids: ['t1'], ...flags })
      await f.vault.load(['w1'])

      expect(f.vault.status('w1')).toBe(reason)
      expect(f.vault.isLoaded('w1')).toBe(false)
      expect(() => f.vault.getEntry('w1')).toThrow(EntryUnavailableError)
      expect(() => f.vault.getContentBytes('w1')).toThrow(EntryUnavailableError)
      expect(f.vault.listLoaded()).toEqual([])
      expect(f.vault.search('draft')).toEqual([])
      expect(f.vault.size).toBe(0)
      expect(f.vault.count()).toBe(0)
      expect(f.vault.journalCounts().size).toBe(0)
      expect(f.vault.getSynced('w1').status).toBe(reason)
    },
  )

  it('hides an entry the web moved into a journal that is excluded', async () => {
    const f = setup()
    f.put({ entry_id: 'e1', journal_id: 'j1', title: 'Moved' })
    await f.vault.load(['e1'])
    f.vault.setOutboxIntents([
      webIntent('e1', {
        created_on_web: false,
        fields: {
          title: null,
          journal_id: {
            value: 'j2',
            base: 'j1',
            base_updated_at: 100,
            change_seq: 1,
            changed_at_secs: 200,
          },
        },
      }),
    ])
    expect(f.vault.getEntry('e1').metadata.journal_id).toBe('j2')

    f.vault.setExcludedJournalIds(['j2'])

    expect(f.vault.status('e1')).toBe('journal')
    expect(f.vault.isLoaded('e1')).toBe(false)
    expect(() => f.vault.getEntry('e1')).toThrow(EntryUnavailableError)
    expect(f.vault.listLoaded()).toEqual([])
    expect(f.vault.search('moved')).toEqual([])
    expect(f.vault.journalCounts().get('j2')).toBeUndefined()
    expect(f.vault.getSynced('e1').status).toBe('visible')
  })

  it('still serves a created_on_web draft with no synced copy and no stub', () => {
    const f = setup()
    f.vault.setOutboxIntents([webIntent('w1')])

    expect(f.vault.status('w1')).toBe('visible')
    expect(f.vault.isLoaded('w1')).toBe(true)
    expect(f.vault.getEntry('w1').metadata.title).toBe('Draft')
    expect(f.vault.search('draft').map((e) => e.metadata.entry_id)).toEqual(['w1'])
    expect(f.vault.count()).toBe(1)
  })
})

describe('foreign intents (other web devices of this vault, read-only)', () => {
  const titleChange = (value: string, base: string, baseUpdatedAt: number) => ({
    title: { value, base, base_updated_at: baseUpdatedAt, change_seq: 1, changed_at_secs: 150 },
  })

  it('overlays a foreign intent on a synced entry', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'Base' })
    await f.vault.load(['a'])

    f.vault.setForeignIntents([
      webIntent('a', {
        created_on_web: false,
        web_device_id: 'web-2',
        fields: titleChange('Other browser', 'Base', 100),
      }),
    ])

    expect(f.vault.getEntry('a').metadata.title).toBe('Other browser')
    expect(f.vault.search('browser').map((e) => e.metadata.entry_id)).toEqual(['a'])
    expect(f.vault.getOutboxIntents()).toEqual([])
    expect(f.vault.getOutboxIntent('a')).toBeUndefined()
  })

  it('never masks a later desktop edit (updated_at moved on and the field left its base)', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 200, title: 'Desktop newer' })
    await f.vault.load(['a'])

    f.vault.setForeignIntents([
      webIntent('a', {
        created_on_web: false,
        web_device_id: 'web-2',
        fields: titleChange('Other browser', 'Base', 100),
      }),
    ])

    expect(f.vault.getEntry('a').metadata.title).toBe('Desktop newer')
  })

  it('an own draft beats a foreign intent for the same entry', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'Base', emotion: null })
    await f.vault.load(['a'])

    f.vault.setForeignIntents([
      webIntent('a', {
        created_on_web: false,
        web_device_id: 'web-2',
        web_updated_at_secs: 999,
        fields: {
          ...titleChange('Foreign', 'Base', 100),
          emotion: {
            value: 'bad',
            base: null,
            base_updated_at: 100,
            change_seq: 1,
            changed_at_secs: 999,
          },
        },
      }),
    ])
    f.vault.setOutboxIntents([
      webIntent('a', { created_on_web: false, fields: titleChange('Mine', 'Base', 100) }),
    ])

    const shown = f.vault.getEntry('a').metadata
    expect(shown.title).toBe('Mine')
    expect(shown.emotion).toBeNull()
  })

  it('orders two foreign devices by web_updated_at_secs, then by the greater device id', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'Base' })
    await f.vault.load(['a'])
    const from = (device: string, at: number) =>
      webIntent('a', {
        created_on_web: false,
        web_device_id: device,
        web_updated_at_secs: at,
        fields: titleChange(device, 'Base', 100),
      })

    f.vault.setForeignIntents([from('web-9', 300), from('web-2', 400)])
    expect(f.vault.getEntry('a').metadata.title).toBe('web-2')
    f.vault.setForeignIntents([from('web-2', 400), from('web-9', 300)])
    expect(f.vault.getEntry('a').metadata.title).toBe('web-2')

    f.vault.setForeignIntents([from('web-9', 400), from('web-2', 400)])
    expect(f.vault.getEntry('a').metadata.title).toBe('web-9')
    f.vault.setForeignIntents([from('web-2', 400), from('web-9', 400)])
    expect(f.vault.getEntry('a').metadata.title).toBe('web-9')
  })

  it('shows a foreign web-created entry but refuses it as a write base', () => {
    const f = setup()
    f.vault.setForeignIntents([webIntent('w2', { web_device_id: 'web-2' })])

    expect(f.vault.status('w2')).toBe('visible')
    expect(f.vault.getEntry('w2').metadata.title).toBe('Draft')
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['w2'])
    expect(() => f.vault.getWriteView('w2')).toThrow(ForeignEntryReadOnlyError)
  })

  it('a foreign web-created entry that a synced manifest knows is loaded, not synthesized', async () => {
    const f = setup()
    f.put({ entry_id: 'w2', updated_at: 300, title: 'Imported' })
    f.vault.setForeignIntents([webIntent('w2', { web_device_id: 'web-2' })])

    expect(f.vault.status('w2')).toBe('not-loaded')
    await f.vault.load(['w2'])
    expect(f.vault.getWriteView('w2').metadata.title).toBe('Imported')
  })

  it('the write view of a synced entry ignores foreign intents (base stays the synced value)', async () => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 100, title: 'Base' }, 'synced-yjs')
    await f.vault.load(['a'])
    f.vault.setForeignIntents([
      webIntent('a', {
        created_on_web: false,
        web_device_id: 'web-2',
        fields: titleChange('Foreign', 'Base', 100),
      }),
    ])

    expect(f.vault.getEntry('a').metadata.title).toBe('Foreign')
    expect(f.vault.getWriteView('a').metadata.title).toBe('Base')
  })

  it.each([
    ['locked', { is_locked: true }],
    ['invisible', { is_invisible: true }],
    ['deleted', { is_deleted: true }],
  ] as const)('a %s stub beats a foreign intent', async (reason, flags) => {
    const f = setup()
    f.put({ entry_id: 'a', updated_at: 300, title: 'Secret', ...flags })
    await f.vault.load(['a'])
    f.vault.setForeignIntents([
      webIntent('a', { web_device_id: 'web-2' }),
      webIntent('b', { created_on_web: false, web_device_id: 'web-2' }),
    ])

    expect(f.vault.status('a')).toBe(reason)
    expect(() => f.vault.getEntry('a')).toThrow(EntryUnavailableError)
    expect(f.vault.listLoaded()).toEqual([])
    // A foreign intent that is not created_on_web and has no synced copy shows nothing.
    expect(f.vault.status('b')).toBe('not-loaded')
  })

  it('applies journal exclusion to the overlaid journal of a foreign intent', async () => {
    const f = setup()
    f.put({ entry_id: 'e1', journal_id: 'j1', title: 'Moved' })
    await f.vault.load(['e1'])
    f.vault.setForeignIntents([
      webIntent('e1', {
        created_on_web: false,
        web_device_id: 'web-2',
        fields: {
          title: null,
          journal_id: {
            value: 'j2',
            base: 'j1',
            base_updated_at: 100,
            change_seq: 1,
            changed_at_secs: 200,
          },
        },
      }),
      webIntent('w2', {
        web_device_id: 'web-2',
        fields: {
          journal_id: {
            value: 'j2',
            base: '',
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 200,
          },
        },
      }),
    ])
    f.vault.setExcludedJournalIds(['j2'])

    expect(f.vault.status('e1')).toBe('journal')
    expect(f.vault.status('w2')).toBe('journal')
    expect(f.vault.listLoaded()).toEqual([])
  })

  it('drops foreign intents on lock', async () => {
    const f = setup()
    f.vault.setForeignIntents([webIntent('w2', { web_device_id: 'web-2' })])
    f.lock()
    f.unlockState.locked = false

    expect(f.vault.status('w2')).toBe('not-loaded')
    expect(f.vault.listLoaded()).toEqual([])
  })
})

describe('trash', () => {
  const SECRET = 'TRASH-SECRET-qrs'

  it('fetches a trashed index winner only through loadTrashed and serves it from trashView', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: 'Binned', updated_at: 500, trashed_at: 450 })
    f.put({ entry_id: 'live', title: 'Kept', updated_at: 400 })
    f.put({ entry_id: 'gone', updated_at: 300, is_deleted: true })
    await f.vault.load(['t'])
    expect(f.fetched).toEqual([])

    expect(f.vault.listTrashedIndex().map((e) => e.entryId)).toEqual(['t'])
    // Live and tombstoned winners are not trashed: never fetched here.
    await f.vault.loadTrashed(['t', 'live', 'gone', 'unknown'])
    expect(f.fetched).toEqual(['t'])
    expect(f.vault.trashView('live')).toBeNull()
    const view = f.vault.trashView('t')
    expect(view).toMatchObject({ trashedAt: 450, pending: false })
    expect(view?.held.metadata.title).toBe('Binned')
    expect(view?.held.contentText).toBe('body')
    expect(new TextDecoder().decode(view?.held.content)).toBe('yjs')
  })

  it('never shows a trashed copy in a live view', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: 'Binned', tag_ids: ['tt'], updated_at: 500, trashed_at: 450 })
    f.put({ entry_id: 'live', title: 'Kept', updated_at: 400 })
    await f.vault.load(['live'])
    await f.vault.loadTrashed(['t'])

    expect(f.vault.trashView('t')).not.toBeNull()
    expect(f.vault.status('t')).toBe('not-loaded')
    expect(f.vault.isLoaded('t')).toBe(false)
    expect(() => f.vault.getEntry('t')).toThrow(EntryUnavailableError)
    expect(f.vault.size).toBe(1)
    expect(f.vault.listLoaded().map((e) => e.metadata.entry_id)).toEqual(['live'])
    expect(f.vault.search('binned')).toEqual([])
    expect(f.vault.count()).toBe(1)
    expect(f.vault.tagCounts().get('tt')).toBeUndefined()
    expect(f.vault.journalCounts().get('j1')).toBe(1)
    expect(f.vault.listIndex().map((e) => e.entryId)).toEqual(['live'])
  })

  it('keeps no plaintext of a locked, invisible, journal-excluded or tombstone payload', async () => {
    const f = setup()
    const secret = { title: SECRET, content_text: SECRET, preview_text: SECRET }
    f.put({ entry_id: 'locked', ...secret, is_locked: true, trashed_at: 10 }, SECRET)
    f.put({ entry_id: 'invis', ...secret, is_invisible: true, trashed_at: 10 }, SECRET)
    f.put({ entry_id: 'jx', ...secret, journal_id: 'jx', trashed_at: 10 }, SECRET)
    // The index still says trashed, the payload is already a tombstone (purged).
    f.put({ entry_id: 'tomb', ...secret, is_deleted: true }, SECRET)
    f.index.set('tomb', {
      entryId: 'tomb',
      authorDevice: 'dev-a',
      updatedAt: 100,
      isDeleted: false,
      trashedAt: 10,
    })
    f.vault.setExcludedJournalIds(['jx'])
    const ids = ['locked', 'invis', 'jx', 'tomb']
    await f.vault.loadTrashed(ids)

    expect(f.fetched.sort()).toEqual([...ids].sort())
    for (const id of ids) expect(f.vault.trashView(id)).toBeNull()
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('falls back to the index trashedAt when the payload has none', async () => {
    const f = setup()
    f.put({ entry_id: 'b', title: 'No stamp' })
    f.index.set('b', {
      entryId: 'b',
      authorDevice: 'dev-a',
      updatedAt: 100,
      isDeleted: false,
      trashedAt: 77,
    })
    await f.vault.loadTrashed(['b'])
    expect(f.vault.trashView('b')).toMatchObject({ trashedAt: 77, pending: false })
  })

  it('does not refetch a copy held at the winner updatedAt, and refetches a newer winner', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: 'v1', updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    await f.vault.loadTrashed(['t'])
    expect(f.fetched).toEqual(['t'])
    f.put({ entry_id: 't', title: 'v2', updated_at: 600, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    expect(f.fetched).toEqual(['t', 't'])
    expect(f.vault.trashView('t')?.held.metadata.title).toBe('v2')
  })

  it('drops a held copy once its payload turns locked', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: SECRET, updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    f.put({ entry_id: 't', title: 'x', updated_at: 600, trashed_at: 450, is_locked: true })
    await f.vault.loadTrashed(['t'])
    expect(f.vault.trashView('t')).toBeNull()
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('stops serving a desktop copy once the index winner is purged or restored', async () => {
    const f = setup()
    f.put({ entry_id: 'p', title: 'purged', updated_at: 500, trashed_at: 450 })
    f.put({ entry_id: 'r', title: 'restored', updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['p', 'r'])
    f.index.set('p', { entryId: 'p', authorDevice: 'dev-a', updatedAt: 600, isDeleted: true })
    f.index.set('r', { entryId: 'r', authorDevice: 'dev-a', updatedAt: 600, isDeleted: false })
    expect(f.vault.trashView('p')).toBeNull()
    expect(f.vault.trashView('r')).toBeNull()
  })

  it('hides a held copy whose journal is excluded later', async () => {
    const f = setup()
    f.put({ entry_id: 't', journal_id: 'j2', updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    expect(f.vault.trashView('t')).not.toBeNull()
    f.vault.setExcludedJournalIds(['j2'])
    expect(f.vault.trashView('t')).toBeNull()
  })

  it.each([
    ['clear()', (f: Fake) => f.vault.clear()],
    ['the lock hook', (f: Fake) => f.lock()],
  ])('%s drops the trashed copies', async (_name, drop) => {
    const f = setup()
    f.put({ entry_id: 't', title: SECRET, updated_at: 500, trashed_at: 450 }, SECRET)
    await f.vault.loadTrashed(['t'])
    expect(f.vault.__debugDump()).toContain(SECRET)
    drop(f)
    expect(f.vault.trashView('t')).toBeNull()
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('discards a loadTrashed result that raced a clear()', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: SECRET, updated_at: 500, trashed_at: 450 })
    const pending = f.vault.loadTrashed(['t'])
    f.vault.clear()
    await pending
    expect(f.vault.trashView('t')).toBeNull()
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('serves a pending web trash from the synced copy with the overlay applied', async () => {
    const f = setup()
    f.put({ entry_id: 'a', title: 'Base', updated_at: 100 })
    await f.vault.load(['a'])
    f.vault.setOutboxIntents([
      webIntent('a', {
        created_on_web: false,
        fields: {
          title: {
            value: 'Edited',
            base: 'Base',
            base_updated_at: 100,
            change_seq: 1,
            changed_at_secs: 150,
          },
        },
      }),
    ])
    expect(f.vault.trashView('a')).toBeNull() // not trashed: a live entry has no trash view
    f.vault.setTrashedIds(['a'])
    const view = f.vault.trashView('a')
    expect(view).toMatchObject({ trashedAt: null, pending: true })
    expect(view?.held.metadata.title).toBe('Edited')
    expect(f.fetched).toEqual(['a'])
  })

  it('serves a pending web trash of a web-created entry from its intent', () => {
    const f = setup()
    f.vault.setOutboxIntents([webIntent('w')])
    f.vault.setTrashedIds(['w'])
    const view = f.vault.trashView('w')
    expect(view).toMatchObject({ trashedAt: null, pending: true })
    expect(view?.held.metadata.title).toBe('Draft')
    expect(view?.held.contentText).toBe('Draft body')
  })

  it('returns null for a pending trash in an excluded journal, or with nothing to show', async () => {
    const f = setup()
    f.put({ entry_id: 'a', journal_id: 'j2' })
    await f.vault.load(['a'])
    f.vault.setOutboxIntents([
      webIntent('w', {
        fields: {
          journal_id: {
            value: 'j2',
            base: '',
            base_updated_at: 0,
            change_seq: 1,
            changed_at_secs: 200,
          },
        },
      }),
    ])
    f.vault.setTrashedIds(['a', 'w', 'nothing'])
    f.vault.setExcludedJournalIds(['j2'])
    expect(f.vault.trashView('a')).toBeNull()
    expect(f.vault.trashView('w')).toBeNull()
    expect(f.vault.trashView('nothing')).toBeNull()
  })

  it('refetches a cached trashed payload older than the winner once', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: 'fresh', updated_at: 500, trashed_at: 450 })
    f.cache({ entry_id: 't', title: SECRET, updated_at: 400, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    expect(f.dropped).toEqual(['t'])
    expect(f.vault.trashView('t')?.held.metadata.title).toBe('fresh')
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('keeps no copy when the refetched payload is still older than the winner', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: 'OLD-HELD-xyz', updated_at: 300, trashed_at: 250 })
    await f.vault.loadTrashed(['t'])
    f.put({ entry_id: 't', title: SECRET, updated_at: 400, trashed_at: 250 })
    f.index.set('t', {
      entryId: 't',
      authorDevice: 'dev-a',
      updatedAt: 500,
      isDeleted: false,
      trashedAt: 250,
    })
    await f.vault.loadTrashed(['t'])
    expect(f.dropped).toEqual(['t'])
    expect(f.vault.trashView('t')).toBeNull()
    expect(f.vault.__debugDump()).not.toContain(SECRET)
    expect(f.vault.__debugDump()).not.toContain('OLD-HELD-xyz')
  })

  it('stops serving a held copy once the trashed winner moved on', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: 'v1', updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    f.index.set('t', {
      entryId: 't',
      authorDevice: 'dev-a',
      updatedAt: 600,
      isDeleted: false,
      trashedAt: 450,
    })
    expect(f.vault.trashView('t')).toBeNull()
  })

  it('drops a held copy when the newer payload fails to open', async () => {
    const f = setup((_id, json) => {
      if (json.includes('CORRUPT')) throw new Error('bad metadata')
    })
    f.put({ entry_id: 't', title: SECRET, updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    expect(f.vault.__debugDump()).toContain(SECRET)
    f.put({ entry_id: 't', title: 'CORRUPT', updated_at: 600, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    expect(f.vault.trashView('t')).toBeNull()
    expect(f.vault.__debugDump()).not.toContain(SECRET)
  })

  it('drops held copies of a journal that becomes excluded', async () => {
    const f = setup()
    f.put({ entry_id: 't', title: SECRET, journal_id: 'j2', updated_at: 500, trashed_at: 450 })
    await f.vault.loadTrashed(['t'])
    f.vault.setExcludedJournalIds(['j2'])
    expect(f.vault.__debugDump()).not.toContain(SECRET)
    f.vault.setExcludedJournalIds([])
    await f.vault.loadTrashed(['t'])
    expect(f.vault.trashView('t')?.held.metadata.title).toBe(SECRET)
  })
})
