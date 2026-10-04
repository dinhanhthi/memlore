import { describe, expect, it, vi } from 'vitest'
import type { KeyRing } from './keys'
import { VaultLockedError } from './keys'
import type { IndexEntry } from './sync/entryIndex'
import type { OutboxEntryV1 } from './sync/outbox'
import { EntryUnavailableError, createVault, type EntryMetadata, type VaultSource } from './vault'

const enc = new TextEncoder()

interface Fake {
  vault: ReturnType<typeof createVault>
  /** Registers a payload; the "ciphertext" is just the entry id. */
  put: (meta: Partial<EntryMetadata> & { entry_id: string }, yjs?: string) => void
  index: Map<string, IndexEntry>
  fetched: string[]
  lock: () => void
  hooks: Array<() => void>
  unlockState: { locked: boolean }
  mergeSpy: ReturnType<typeof vi.fn>
}

function setup(): Fake {
  const payloads = new Map<string, { metadataJson: string; yjs: Uint8Array }>()
  const index = new Map<string, IndexEntry>()
  const fetched: string[] = []
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
      return new Map(ids.filter((id) => payloads.has(id)).map((id) => [id, enc.encode(id)]))
    },
  }
  const vault = createVault({
    core: {
      openEntry: (_ring: KeyRing, bytes: Uint8Array) => {
        const found = payloads.get(new TextDecoder().decode(bytes))
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
  })
  const put: Fake['put'] = (meta, yjs = 'yjs') => {
    const full: EntryMetadata = {
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
    }
    payloads.set(full.entry_id, { metadataJson: JSON.stringify(full), yjs: enc.encode(yjs) })
    index.set(full.entry_id, {
      entryId: full.entry_id,
      authorDevice: full.device_id,
      updatedAt: full.updated_at,
      isDeleted: full.is_deleted,
    })
  }
  return {
    vault,
    put,
    index,
    fetched,
    hooks,
    unlockState,
    mergeSpy,
    lock: () => {
      unlockState.locked = true
      for (const hook of hooks) hook()
    },
  }
}

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
    expect(JSON.parse(f.vault.__debugDump())).toEqual({ entries: [], stubs: [] })
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
    await f.vault.load(['a'])
    expect(f.mergeSpy).toHaveBeenCalledTimes(1)
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
