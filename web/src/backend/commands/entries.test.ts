import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Entry } from '../../../../src/types/entry'
import type { PagedResult } from '../../../../src/types/pagination'
import {
  MAX_LOAD_ROUNDS,
  MSG_UNAVAILABLE,
  entryHandlers,
  setCustomMediaPicker,
  timeRangeBounds,
  toEntry,
} from './entries'
import { configureReadEnv, type Taxonomy } from './readSession'
import { installFakeSession, type FakeSpec } from './readTestKit'
import { setWriteFlagForTest } from '../config'
import { resetClock, updateClockOffset } from '../clock'
import { lock, setKeyRing, type KeyRing } from '../keys'

afterEach(() => {
  configureReadEnv({})
  setWriteFlagForTest(false)
  setCustomMediaPicker(null)
  lock('manual')
})

const PAGE_ARGS = {
  sort: 'newest',
  range: 'all',
  fromTs: null,
  toTs: null,
  firstDayOfWeek: 1,
  lockedView: 'revealed',
  activeVaultId: null,
  lockFilter: 'all',
}

const call = <T>(name: string, args: Record<string, unknown>): Promise<T> =>
  Promise.resolve(entryHandlers[name](args)) as Promise<T>

const listAll = (page: number, extra: Record<string, unknown> = {}) =>
  call<PagedResult<Entry>>('list_all_entries_paged', { ...PAGE_ARGS, page, ...extra })

const id = (n: number): string => `e${String(n).padStart(2, '0')}`

/** e01 is the most recently updated; the entry date runs the other way round. */
function many(count: number, patch: (n: number) => Partial<FakeSpec> = () => ({})): FakeSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    updatedAt: 1000 - i,
    entryDate: 100 + i,
    ...patch(i + 1),
  }))
}

describe('paged lists', () => {
  it('fetches pages in updated order and shows the loaded set by entry date', async () => {
    const { vault } = installFakeSession(many(12), { pageSize: 5 })
    const first = await listAll(1)
    expect(vault.loadCalls).toEqual([[id(1), id(2), id(3), id(4), id(5)]])
    // The 5 most recently updated are e01..e05; their entry dates grow with the number.
    expect(first.items.map((e) => e.id)).toEqual([id(5), id(4), id(3), id(2), id(1)])
    // (page 1 of the loaded set; it is re-sorted as more entries load, see the file header)
    // total = loaded matches + ids not loaded yet (follows the index).
    expect(first.total).toBe(12)

    const second = await listAll(2)
    expect(vault.loadCalls[1]).toEqual([id(6), id(7), id(8), id(9), id(10)])
    // The loaded set (e01..e10) is sorted by entry date: page 2 is its 6th to 10th newest.
    expect(second.items.map((e) => e.id)).toEqual([id(5), id(4), id(3), id(2), id(1)])
    expect(second.total).toBe(12)

    const third = await listAll(3)
    expect(third.items.map((e) => e.id)).toEqual([id(2), id(1)])
    expect(third.total).toBe(12)
    expect((await listAll(4)).items).toEqual([])
  })

  it('does not download anything when the loaded set already fills the page', async () => {
    const { vault } = installFakeSession(many(6), { pageSize: 3 })
    await vault.load([id(1), id(2), id(3), id(4), id(5)])
    vault.loadCalls.length = 0
    const page = await listAll(1)
    expect(page.items).toHaveLength(3)
    expect(vault.loadCalls).toEqual([])
  })

  it('keeps fetching past locked, invisible and failing ids until the page is full', async () => {
    const specs = many(12, (n) => ({
      locked: n === 3,
      invisible: n === 4,
      fails: n === 5,
    }))
    const { vault } = installFakeSession(specs, { pageSize: 5 })
    const page = await listAll(1)
    expect(page.items).toHaveLength(5)
    const ids = page.items.map((e) => e.id)
    expect(ids).not.toContain(id(3))
    expect(ids).not.toContain(id(4))
    expect(ids).not.toContain(id(5))
    expect(vault.loadCalls.flat().filter((x) => x === id(5))).toHaveLength(1)
    // Excluded ids are no longer counted once discovered (the failing e05 still is).
    expect(page.total).toBe(10)
  })

  it('stops when the index is exhausted and reports an exact total', async () => {
    const specs = [...many(4), { id: 'gone', updatedAt: 1, tombstone: true }]
    const { vault } = installFakeSession(specs, { pageSize: 20 })
    const page = await listAll(1)
    expect(page.items).toHaveLength(4)
    expect(page.total).toBe(4)
    expect(vault.loadCalls.flat().sort()).toEqual([id(1), id(2), id(3), id(4)])
  })

  it('is bounded: a filter that matches nothing stops after MAX_LOAD_ROUNDS pages', async () => {
    const count = MAX_LOAD_ROUNDS * 2 + 10
    const { vault } = installFakeSession(many(count), { pageSize: 2 })
    const page = await call<PagedResult<Entry>>('list_entries_paged', {
      ...PAGE_ARGS,
      journalId: 'nowhere',
      page: 1,
    })
    expect(page.items).toEqual([])
    expect(vault.loadCalls).toHaveLength(MAX_LOAD_ROUNDS)
    expect(page.total).toBe(count - MAX_LOAD_ROUNDS * 2)
  })

  it('supports the oldest and recentlyEdited sorts', async () => {
    installFakeSession(many(4))
    expect((await listAll(1, { sort: 'oldest' })).items.map((e) => e.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ])
    expect((await listAll(1, { sort: 'recentlyEdited' })).items.map((e) => e.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ])
  })

  it('treats an inherited property name as an unknown sort (falls back to newest)', async () => {
    installFakeSession(many(3))
    const newest = (await listAll(1)).items.map((e) => e.id)
    for (const sort of ['toString', 'constructor', '__proto__']) {
      expect((await listAll(1, { sort })).items.map((e) => e.id)).toEqual(newest)
    }
  })

  it('filters by journal, favorites and tag, and applies a custom date range', async () => {
    const specs = many(6, (n) => ({
      journal: n % 2 === 0 ? 'jb' : 'ja',
      favorite: n <= 2,
      tags: n === 2 || n === 3 ? ['t1'] : [],
    }))
    installFakeSession(specs)
    const journal = await call<PagedResult<Entry>>('list_entries_paged', {
      ...PAGE_ARGS,
      journalId: 'jb',
      page: 1,
    })
    expect(journal.items.map((e) => e.id).sort()).toEqual([id(2), id(4), id(6)])
    expect(journal.total).toBe(3)

    const favAll = await call<PagedResult<Entry>>('list_favorite_entries_paged', {
      ...PAGE_ARGS,
      journalId: null,
      page: 1,
    })
    expect(favAll.items.map((e) => e.id).sort()).toEqual([id(1), id(2)])
    const favJournal = await call<PagedResult<Entry>>('list_favorite_entries_paged', {
      ...PAGE_ARGS,
      journalId: 'jb',
      page: 1,
    })
    expect(favJournal.items.map((e) => e.id)).toEqual([id(2)])

    const tag = await call<PagedResult<Entry>>('list_entries_by_tag_paged', {
      ...PAGE_ARGS,
      tagId: 't1',
      journalId: null,
      favoritesOnly: true,
      page: 1,
    })
    expect(tag.items.map((e) => e.id)).toEqual([id(2)])

    // entry dates are 100..105: [101, 103) keeps e02 and e03.
    const ranged = await listAll(1, { fromTs: 101, toTs: 103 })
    expect(ranged.items.map((e) => e.id)).toEqual([id(3), id(2)])
  })

  it('answers the second-lock and invisible views with nothing, without downloading', async () => {
    const { vault } = installFakeSession(many(3))
    for (const lockFilter of ['secondLocked', 'invisibleLocked']) {
      expect(await listAll(1, { lockFilter })).toEqual({ items: [], total: 0 })
    }
    expect(vault.loadCalls).toEqual([])
  })

  it('treats a bad page number as page 1', async () => {
    installFakeSession(many(3))
    expect((await listAll(0)).items).toHaveLength(3)
    expect((await listAll(-4)).items).toHaveLength(3)
  })
})

describe('time ranges', () => {
  // Sat 2026-10-03 12:00 local.
  const now = new Date(2026, 9, 3, 12).getTime()
  const day = (y: number, m: number, d: number): number =>
    Math.floor(new Date(y, m, d).getTime() / 1000)

  it('computes local calendar bounds like the desktop', () => {
    expect(timeRangeBounds('all', 1, now)).toBeNull()
    expect(timeRangeBounds('today', 1, now)).toEqual([day(2026, 9, 3), day(2026, 9, 4)])
    expect(timeRangeBounds('thisMonth', 1, now)).toEqual([day(2026, 9, 1), day(2026, 10, 1)])
    expect(timeRangeBounds('thisYear', 1, now)).toEqual([day(2026, 0, 1), day(2027, 0, 1)])
    // Saturday: week starts Monday 2026-09-28, or Sunday 2026-09-27.
    expect(timeRangeBounds('thisWeek', 1, now)).toEqual([day(2026, 8, 28), day(2026, 9, 5)])
    expect(timeRangeBounds('thisWeek', 0, now)).toEqual([day(2026, 8, 27), day(2026, 9, 4)])
  })
})

describe('single entry', () => {
  it('fetches an unloaded entry on demand and returns the desktop Entry shape', async () => {
    const { vault } = installFakeSession([
      {
        id: 'a',
        updatedAt: 5,
        entryDate: 50,
        title: 'T',
        text: 'B',
        emotion: 'good',
        favorite: true,
        media: 2,
        yjs: [9, 8, 7],
      },
    ])
    const entry = await call<Entry>('get_entry', { id: 'a', activeVaultId: null })
    expect(vault.loadCalls).toEqual([['a']])
    expect(entry).toMatchObject({
      id: 'a',
      journal_id: 'j1',
      title: 'T',
      content_text: 'B',
      entry_date: 50,
      emotion: 'good',
      is_favorite: true,
      is_deleted: false,
      is_locked: false,
      is_invisible: false,
      vault_id: null,
      media_count: 2,
      from_chat: false,
      latitude: null,
      entry_date_user_edited: false,
    })
    await call('get_entry', { id: 'a' })
    expect(vault.loadCalls).toHaveLength(1)
    expect(await call('get_entry_content', { id: 'a' })).toEqual([9, 8, 7])
  })

  it('returns null for an unknown id and for an entry without a body', async () => {
    installFakeSession([{ id: 'empty', updatedAt: 1, yjs: [] }])
    expect(await call('get_entry', { id: 'nope' })).toBeNull()
    expect(await call('get_entry_content', { id: 'nope' })).toBeNull()
    expect(await call('get_entry_content', { id: 'empty' })).toBeNull()
  })

  it('rejects locked, invisible and deleted entries with a clear message', async () => {
    installFakeSession([
      { id: 'l', updatedAt: 3, locked: true },
      { id: 'i', updatedAt: 2, invisible: true },
      { id: 'd', updatedAt: 1, tombstone: true },
    ])
    for (const name of ['get_entry', 'get_entry_content']) {
      for (const entryId of ['l', 'i', 'd']) {
        await expect(call(name, { id: entryId })).rejects.toThrow(MSG_UNAVAILABLE)
      }
    }
  })

  it('surfaces an entry that cannot be opened', async () => {
    installFakeSession([{ id: 'x', updatedAt: 1, fails: true }])
    await expect(call('get_entry', { id: 'x' })).rejects.toThrow('Could not open this entry: boom')
  })

  it('coerces an unknown emotion to null and counts media', () => {
    const { vault } = installFakeSession([{ id: 'a', updatedAt: 1, emotion: 'angry', media: 3 }])
    return vault.load(['a']).then(() => {
      const entry = toEntry(vault.getEntry('a'))
      expect(entry.emotion).toBeNull()
      expect(entry.media_count).toBe(3)
    })
  })
})

describe('reads over the loaded set', () => {
  // UTC midnight 2024-03-05 and 2023-03-05 (on-this-day buckets by UTC).
  const d2024 = Date.UTC(2024, 2, 5, 10) / 1000
  const d2023 = Date.UTC(2023, 2, 5, 10) / 1000
  const specs: FakeSpec[] = [
    { id: 'a', updatedAt: 9, entryDate: d2024, journal: 'j1', emotion: 'good' },
    { id: 'b', updatedAt: 8, entryDate: d2023, journal: 'j2', emotion: 'bad' },
    { id: 'c', updatedAt: 7, entryDate: d2024 + 7200, journal: 'j1', emotion: 'neutral' },
    { id: 'z', updatedAt: 1, entryDate: d2024, locked: true, emotion: 'bad' },
  ]

  async function loadAll(): Promise<void> {
    installFakeSession(specs)
    await listAll(1)
  }

  it('lists entry dates, a date range and per-journal counts, never the locked entry', async () => {
    await loadAll()
    expect(await call('list_entry_dates', { journalId: null })).toEqual([
      d2024 + 7200,
      d2024,
      d2023,
    ])
    expect(await call('list_entry_dates', { journalId: 'j2' })).toEqual([d2023])
    const range = await call<Entry[]>('list_entries_for_date_range', {
      journalId: null,
      fromTs: d2024 - 100,
      toTs: d2024 + 100,
    })
    expect(range.map((e) => e.id)).toEqual(['a'])
    expect(await call('count_entries_in_journal', { journalId: 'j1' })).toBe(2)
  })

  it('lists on-this-day across years and validates month and day', async () => {
    await loadAll()
    const hits = await call<Entry[]>('list_on_this_day', { month: 3, day: 5 })
    expect(hits.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    await expect(call('list_on_this_day', { month: 13, day: 1 })).rejects.toThrow('month must be')
    await expect(call('list_on_this_day', { month: 1, day: 0 })).rejects.toThrow('day must be')
  })

  it('returns one pair per day and emotion for the year, latest first within a day', async () => {
    await loadAll()
    const pairs = await call<Array<[string, string]>>('get_emotion_by_date', { year: 2024 })
    const dates = pairs.map(([date]) => date)
    expect([...dates].sort()).toEqual(dates)
    expect(pairs.map(([, emotion]) => emotion).sort()).toEqual(['good', 'neutral'])
    expect(pairs.every(([date]) => /^2024-03-0[56]$/.test(date))).toBe(true)
    expect(await call('get_emotion_by_date', { year: 2020 })).toEqual([])
  })
})

describe('locked vault', () => {
  it('rejects every handler and downloads nothing', async () => {
    const { vault, setUnlocked } = installFakeSession(many(3))
    setUnlocked(false)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_entries_paged', { ...PAGE_ARGS, journalId: 'j1', page: 1 }],
      ['list_all_entries_paged', { ...PAGE_ARGS, page: 1 }],
      ['list_favorite_entries_paged', { ...PAGE_ARGS, journalId: null, page: 1 }],
      ['list_entries_by_tag_paged', { ...PAGE_ARGS, tagId: 't', journalId: null, page: 1 }],
      ['get_entry', { id: id(1) }],
      ['get_entry_content', { id: id(1) }],
      ['list_entry_dates', { journalId: null }],
      ['list_entries_for_date_range', { journalId: null, fromTs: 0, toTs: 1 }],
      ['list_on_this_day', { month: 1, day: 1 }],
      ['get_emotion_by_date', { year: 2024 }],
      ['count_entries_in_journal', { journalId: 'j1' }],
    ]
    for (const [name, args] of calls) {
      await expect(call(name, args), name).rejects.toThrow('vault is locked')
    }
    expect(vault.loadCalls).toEqual([])
  })
})

describe('write commands', () => {
  const TAXONOMY: Taxonomy = {
    journals: [
      {
        id: 'j1',
        name: 'Daily',
        color: null,
        sort_order: 1,
        created_at: 1000,
        updated_at: 1000,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        is_initial_placeholder: false,
      },
      {
        id: 'j2',
        name: 'Work',
        color: null,
        sort_order: 2,
        created_at: 2000,
        updated_at: 2000,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: null,
        is_initial_placeholder: false,
      },
    ],
    autoTagIds: { j1: ['t1', 't2'] },
    excludedJournalIds: [],
    knownJournalIds: ['j1', 'j2'],
    tags: [
      { id: 't1', name: 'Work', color: null },
      { id: 't2', name: 'Ideas', color: null },
    ],
    templates: [],
  }

  it('rejects every write command with read_only when write flag is disabled', async () => {
    setWriteFlagForTest(false)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(2), { taxonomy: TAXONOMY })

    const writeCalls: Array<[string, Record<string, unknown>]> = [
      ['create_entry', { journalId: 'j1', title: 'New' }],
      ['save_entry_content', { id: id(1), yjsDoc: [], contentText: '', previewText: '' }],
      ['update_entry', { id: id(1), title: 'Updated' }],
      ['update_entry_date', { id: id(1), entryDate: 12345 }],
      ['update_entry_emotion', { id: id(1), emotion: 'good' }],
      ['toggle_favorite', { id: id(1) }],
      ['move_entry_to_journal', { id: id(1), journalId: 'j2' }],
      ['add_tag_to_entry', { entryId: id(1), tagId: 't1' }],
      ['remove_tag_from_entry', { entryId: id(1), tagId: 't1' }],
      ['pick_image', { entryId: id(1) }],
      ['pick_video', { entryId: id(1) }],
      ['save_pasted_image', { entryId: id(1), bytes: [1, 2, 3], mime: 'image/png' }],
    ]

    for (const [name, args] of writeCalls) {
      await expect(call(name, args), name).rejects.toThrow('read_only')
    }
  })

  it('get_media_upload_limits returns default caps even when write flag is disabled', async () => {
    setWriteFlagForTest(false)
    const limits = await call<{ photoBytes: number; videoBytes: number }>('get_media_upload_limits', {})
    expect(limits.photoBytes).toBe(5 * 1024 * 1024)
    expect(limits.videoBytes).toBe(100 * 1024 * 1024)
  })

  it('create_entry generates UUID, applies auto-tags, saves draft, and overlays into vault', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted, db } = installFakeSession([], { taxonomy: TAXONOMY })

    const created = await call<Entry>('create_entry', {
      journalId: 'j1',
      title: 'First web entry',
      contentText: 'Hello web companion',
      previewText: 'Hello web companion',
      entryDate: 1700000000,
    })

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.title).toBe('First web entry')
    expect(created.journal_id).toBe('j1')
    expect(created.content_text).toBe('Hello web companion')
    expect(created.entry_date).toBe(1700000000)

    // Verify overlaid in vault
    const fromVault = vault.getEntry(created.id)
    expect(fromVault.metadata.title).toBe('First web entry')
    expect(fromVault.metadata.tag_ids).toEqual(['t1', 't2']) // auto tags

    // Verify draft saved
    const drafts = await db.drafts.list()
    expect(drafts.length).toBe(1)
    expect(drafts[0].entryId).toBe(created.id)

    expect(emitted).toContain('memlore:entries-changed')
  })

  it('stamps intents with the Drive-corrected clock, not the browser clock', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { db } = installFakeSession(many(2), { taxonomy: TAXONOMY })
    const browserNow = Date.now()
    // Drive says the time is one hour ahead of this browser.
    updateClockOffset(new Date(browserNow + 3_600_000).toUTCString(), browserNow)
    try {
      await call('toggle_favorite', { id: id(1) })
      const draft = await db.drafts.get(id(1))
      const intent = JSON.parse(new TextDecoder().decode(draft?.sealed)) as {
        web_updated_at_secs: number
        fields: { is_favorite: { changed_at_secs: number } }
      }
      const expected = Math.floor(browserNow / 1000) + 3600
      expect(Math.abs(intent.web_updated_at_secs - expected)).toBeLessThanOrEqual(5)
      expect(Math.abs(intent.fields.is_favorite.changed_at_secs - expected)).toBeLessThanOrEqual(5)
    } finally {
      resetClock()
    }
  })

  it('create_entry rejects when journalId is missing or unknown', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession([], { taxonomy: TAXONOMY })

    await expect(call('create_entry', { journalId: '' })).rejects.toThrow('journalId is required')
    await expect(call('create_entry', { journalId: 'unknown_j' })).rejects.toThrow('Journal not found')
  })

  it('save_entry_content updates Yjs doc, contentText, and draft', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted, db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    await call('save_entry_content', {
      id: id(1),
      yjsDoc: [1, 2, 3, 4],
      contentText: 'Updated body text',
      previewText: 'Updated preview text',
    })

    const fromVault = vault.getEntry(id(1))
    expect(fromVault.contentText).toBe('Updated body text')
    expect(fromVault.previewText).toBe('Updated preview text')

    const drafts = await db.drafts.list()
    expect(drafts.length).toBe(1)
    expect(drafts[0].entryId).toBe(id(1))
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('update_entry updates title and preserves metadata', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const updated = await call<Entry>('update_entry', {
      id: id(1),
      title: 'Renamed entry',
    })

    expect(updated.title).toBe('Renamed entry')
    expect(vault.getEntry(id(1)).metadata.title).toBe('Renamed entry')
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('update_entry_date updates date and emits changed', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault, emitted } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    await call('update_entry_date', {
      id: id(1),
      entryDate: 1711111111,
    })

    expect(vault.getEntry(id(1)).metadata.entry_date).toBe(1711111111)
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('update_entry_emotion updates emotion or clears to null, rejecting invalid values', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const withGood = await call<Entry>('update_entry_emotion', { id: id(1), emotion: 'good' })
    expect(withGood.emotion).toBe('good')
    expect(vault.getEntry(id(1)).metadata.emotion).toBe('good')

    const withNull = await call<Entry>('update_entry_emotion', { id: id(1), emotion: null })
    expect(withNull.emotion).toBe(null)
    expect(vault.getEntry(id(1)).metadata.emotion).toBe(null)

    await expect(call('update_entry_emotion', { id: id(1), emotion: 'ecstatic' })).rejects.toThrow('invalid emotion')
  })

  it('toggle_favorite flips is_favorite and returns new boolean', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(many(1, () => ({ favorite: false })), { taxonomy: TAXONOMY })

    const first = await call<boolean>('toggle_favorite', { id: id(1) })
    expect(first).toBe(true)
    expect(vault.getEntry(id(1)).metadata.is_favorite).toBe(true)

    const second = await call<boolean>('toggle_favorite', { id: id(1) })
    expect(second).toBe(false)
    expect(vault.getEntry(id(1)).metadata.is_favorite).toBe(false)
  })

  it('move_entry_to_journal moves entry to visible journal, rejecting unknown journals', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(many(1, () => ({ journal: 'j1' })), { taxonomy: TAXONOMY })

    await call('move_entry_to_journal', { id: id(1), journalId: 'j2' })
    expect(vault.getEntry(id(1)).metadata.journal_id).toBe('j2')

    await expect(call('move_entry_to_journal', { id: id(1), journalId: 'bad_j' })).rejects.toThrow('Journal not found')
  })

  it('add_tag_to_entry and remove_tag_from_entry modify existing tags only', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(many(1, () => ({ tags: [] })), { taxonomy: TAXONOMY })

    await call('add_tag_to_entry', { entryId: id(1), tagId: 't1' })
    expect(vault.getEntry(id(1)).metadata.tag_ids).toContain('t1')

    await call('remove_tag_from_entry', { entryId: id(1), tagId: 't1' })
    expect(vault.getEntry(id(1)).metadata.tag_ids).not.toContain('t1')

    await expect(call('add_tag_to_entry', { entryId: id(1), tagId: 'nonexistent' })).rejects.toThrow('Tag not found')
  })

  it('pick_image returns null when user cancels file picker', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(1), { taxonomy: TAXONOMY })
    setCustomMediaPicker(async () => null) // user cancelled

    const result = await call('pick_image', { entryId: id(1) })
    expect(result).toBeNull()
  })

  it('pick_image enforces photo size limit', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(1), { taxonomy: TAXONOMY })

    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    setCustomMediaPicker(async () => oversized)

    await expect(call('pick_image', { entryId: id(1) })).rejects.toThrow('IMAGE_TOO_LARGE')
  })

  it('pick_image saves media and thumbnail into outbox blobs and updates intent', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { emitted, db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const file = new File([new Uint8Array([10, 20, 30])], 'photo.jpg', { type: 'image/jpeg' })
    setCustomMediaPicker(async () => file)

    const res = await call<{ mediaId: string; localPath: string }>('pick_image', { entryId: id(1) })
    expect(res.mediaId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.localPath).toBe(`memlore-web://media/${res.mediaId}`)

    // Check media blob stored in db.blobs
    const blob = await db.blobs.get(`outbox/m-${res.mediaId}`)
    expect(blob).toBeDefined()
    const thumbBlob = await db.blobs.get(`outbox/m-${res.mediaId}.thumb`)
    expect(thumbBlob).toBeDefined()

    expect(emitted).toContain('media-changed')
    expect(emitted).toContain('memlore:entries-changed')
  })

  it('save_pasted_image saves pasted bytes, generates thumbnail, and returns mediaId', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { db } = installFakeSession(many(1), { taxonomy: TAXONOMY })

    const res = await call<{ mediaId: string; localPath: string }>('save_pasted_image', {
      entryId: id(1),
      bytes: [50, 60, 70],
      mime: 'image/png',
    })

    expect(res.mediaId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.localPath).toBe(`memlore-web://media/${res.mediaId}`)

    const blob = await db.blobs.get(`outbox/m-${res.mediaId}`)
    expect(blob).toBeDefined()
  })

  it('pick_image and save_pasted_image reject unsupported or dangerous MIME types', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    installFakeSession(many(1), { taxonomy: TAXONOMY })

    const badFile = new File([new Uint8Array([1, 2, 3])], 'attack.html', { type: 'text/html' })
    setCustomMediaPicker(async () => badFile)
    await expect(call('pick_image', { entryId: id(1) })).rejects.toThrow('unsupported mime type')

    await expect(
      call('save_pasted_image', {
        entryId: id(1),
        bytes: [1, 2, 3],
        mime: 'text/html',
      }),
    ).rejects.toThrow('unsupported mime type')
  })

  it('preserves content_text and preview_text across metadata updates', async () => {
    setWriteFlagForTest(true)
    setKeyRing({ lock: () => undefined } as unknown as KeyRing)
    const { vault } = installFakeSession(
      many(1, () => ({ text: 'My precious journal content' })),
      { taxonomy: TAXONOMY },
    )

    // First save content
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'My updated journal content')
    await call('save_entry_content', {
      id: id(1),
      yjsDoc: Array.from(Y.encodeStateAsUpdate(doc)),
      contentText: 'My updated journal content',
      previewText: 'My updated journal content',
    })

    const intentAfterContent = vault.getOutboxIntent(id(1))
    expect(intentAfterContent?.content_text).toBe('My updated journal content')

    // Now do metadata-only updates
    await call('toggle_favorite', { id: id(1) })
    const intentAfterFav = vault.getOutboxIntent(id(1))
    expect(intentAfterFav?.content_text).toBe('My updated journal content')
    expect(intentAfterFav?.preview_text).toBe('My updated journal content')

    await call('update_entry_emotion', { id: id(1), emotion: 'good' })
    const intentAfterEmotion = vault.getOutboxIntent(id(1))
    expect(intentAfterEmotion?.content_text).toBe('My updated journal content')
  })
})
