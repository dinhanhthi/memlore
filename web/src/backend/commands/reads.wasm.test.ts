import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Entry, SearchResult } from '../../../../src/types/entry'
import type { Journal, Tag } from '../../../../src/types/journal'
import type { PagedResult } from '../../../../src/types/pagination'
import { loadCore, type Core } from '../../core/core'
import { DriveReader, DriveWriter } from '../drive/client'
import {
  FakeDrive,
  fakeLocks,
  fixtureBytes,
  loadDesktopFixture,
  seedFromFixture,
  violations,
  type DesktopFixture,
} from '../drive/fakeDrive'
import { configureKeysEnv, dispose, isUnlocked, lock } from '../keys'
import { openWebDb } from '../storage/idb'
import { onboardComplete } from '../sync/onboard'
import { clearReonboardReason } from '../sync/pull'
import { MSG_UNAVAILABLE, entryHandlers } from './entries'
import { configureReadEnv, createReadSession } from './readSession'
import { cancelSearchScan, searchHandlers, whenSearchScanSettled } from './search'
import { taxonomyHandlers } from './taxonomy'

const PASSWORD = '12345678'
const OWN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const OTHER_DEVICE = 'dddddddd-2222-4333-8444-eeeeeeeeeeee'
const NEWEST = 1791025173
const SHA1_NOTE = 'fixture is read-only'

interface ExpectedEntry {
  entry_id: string
  title: string
  content_text: string
  is_locked: boolean
  tags: string[]
}

let core: Core
let fixture: DesktopFixture
const expected = (): ExpectedEntry[] => fixture.expected.entries as ExpectedEntry[]
const lockedEntry = (): ExpectedEntry => {
  const found = expected().find((e) => e.is_locked)
  if (!found) throw new Error('no locked fixture entry')
  return found
}

interface Env {
  drive: FakeDrive
  emitted: string[]
  /** Fires when an entry payload is downloaded (1-based count). */
  onEntryGet: { current: ((n: number) => void) | null }
}

const handlers = { ...entryHandlers, ...taxonomyHandlers, ...searchHandlers }
const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(handlers[name](args)) as Promise<T>

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
const listAll = (page: number) =>
  call<PagedResult<Entry>>('list_all_entries_paged', { ...PAGE_ARGS, page })
const search = (query: string, extra: Record<string, unknown> = {}) =>
  call<SearchResult[]>('search_entries', {
    query,
    filters: undefined,
    lockedView: 'revealed',
    activeVaultId: null,
    mentionMode: false,
    ...extra,
  })

async function setup(options: { pageSize?: number; extraRows?: number } = {}): Promise<Env> {
  const drive = new FakeDrive()
  seedFromFixture(drive, fixture)
  if (options.extraRows !== undefined) addSecondDevice(drive, options.extraRows)
  const onEntryGet: Env['onEntryGet'] = { current: null }
  let entryGets = 0
  drive.interceptors.push((req) => {
    if (req.url.searchParams.get('alt') === 'media') {
      const file = drive.files.find((f) => req.url.pathname.endsWith(`/${f.id}`))
      if (file !== undefined && /^[0-9a-f-]{36}\.bin$/.test(file.name) && file.name !== OWN_ID) {
        const parent = drive.files.find((f) => f.id === file.parents[0])
        if (parent?.name === 'entries') {
          entryGets += 1
          onEntryGet.current?.(entryGets)
        }
      }
    }
    return undefined
  })
  const deps = {
    getToken: async () => 'tok',
    fetchImpl: (input: string, init?: RequestInit) => drive.fetch(input, init),
    sleep: async () => {},
    locks: fakeLocks(drive),
  }
  const reader = new DriveReader(deps)
  const writer = new DriveWriter(reader, deps)
  const db = await openWebDb({ factory: new IDBFactory() })
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
  drive.requests.length = 0
  const session = await createReadSession({ db, reader, core })
  const emitted: string[] = []
  configureReadEnv({
    session: async () => session,
    emit: (event) => {
      emitted.push(event)
    },
    pageSize: options.pageSize ?? 20,
  })
  return { drive, emitted, onEntryGet }
}

/** A second desktop with `count` old rows whose files are copies of one fixture entry (they fail to open). */
function addSecondDevice(drive: FakeDrive, count: number): void {
  const rows = Array.from({ length: count }, (_, i) => ({
    entry_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    updated_at: NEWEST - 100 - i,
    is_deleted: false,
    local_version: 1,
  }))
  const folder = drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE)
  drive.addFile(
    'metadata.json',
    folder,
    JSON.stringify({
      device_id: OTHER_DEVICE,
      recovery_generation: 0,
      entries: rows,
      journals: [],
      chats_present: false,
      memory_present: false,
      generated_at: NEWEST,
    }),
  )
  const entries = drive.chain('Memlore', 'generations', 'g-0', OTHER_DEVICE, 'entries')
  const source = fixtureBytes(
    fixture,
    `generations/g-0/${fixture.device_id}/entries/${expected()[0].entry_id}.bin`,
  )
  for (const row of rows) drive.addFile(`${row.entry_id}.bin`, entries, source)
}

function pathOf(drive: FakeDrive, id: string): string {
  const parts: string[] = []
  let current = drive.files.find((f) => f.id === id)
  while (current && current.parents[0] !== 'appDataFolder') {
    parts.unshift(current.name)
    const parent: string = current.parents[0]
    current = drive.files.find((f) => f.id === parent)
  }
  return parts.join('/')
}

const downloads = (drive: FakeDrive): string[] =>
  drive.requests
    .filter((r) => r.method === 'GET' && r.url.searchParams.get('alt') === 'media')
    .map((r) => pathOf(drive, /\/files\/([^/]+)$/.exec(r.url.pathname)?.[1] ?? ''))

const entryDownloads = (drive: FakeDrive): string[] =>
  downloads(drive).filter((p) => /\/entries\/[^/]+\.bin$/.test(p))
const mediaDownloads = (drive: FakeDrive): string[] =>
  downloads(drive).filter((p) => p.includes('/media/'))

const titles = (rows: Array<{ title: string | null }>): Array<string | null> =>
  rows.map((r) => r.title)

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
  cancelSearchScan()
  configureReadEnv({})
  dispose()
  expect(violations, SHA1_NOTE).toEqual([])
})

describe('lists with the desktop fixture', () => {
  it('shows only the warm-start entries until a page needs more, then loads on demand', async () => {
    const { drive } = await setup({ pageSize: 2 })
    // Page 1 needs 2 entries; the 5 warm-start entries (4 visible) already cover it.
    const first = await listAll(1)
    expect(first.items).toHaveLength(2)
    expect(entryDownloads(drive)).toHaveLength(5)
    const dates = first.items.map((e) => e.entry_date)
    expect([...dates].sort((a, b) => b - a)).toEqual(dates)
    expect((await listAll(2)).items).toHaveLength(2)
    expect(entryDownloads(drive)).toHaveLength(5)

    // Page 3 needs 6 visible entries: only the 2 remaining payloads are fetched.
    const third = await listAll(3)
    expect(entryDownloads(drive)).toHaveLength(7)
    expect(third.items).toHaveLength(2)
    expect(third.total).toBe(6)
    expect(mediaDownloads(drive)).toEqual([])
    expect(drive.mutating()).toEqual([])
  })

  it('never lists, counts or returns the locked entry anywhere', async () => {
    const locked = lockedEntry()
    await setup()
    const page = await listAll(1)
    expect(page.total).toBe(6)
    expect(titles(page.items).sort()).toEqual(
      expected()
        .filter((e) => !e.is_locked)
        .map((e) => e.title)
        .sort(),
    )
    const journals = await call<Journal[]>('list_journals')
    const counts = await Promise.all(
      journals.map((j) => call<number>('count_entries_in_journal', { journalId: j.id })),
    )
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6)
    const dates = await call<number[]>('list_entry_dates', { journalId: null })
    expect(dates).toHaveLength(6)
    expect(await search('sixth')).toEqual([])
    expect(await search('golden', { mentionMode: true })).toHaveLength(6)
    await expect(call('get_entry', { id: locked.entry_id })).rejects.toThrow(MSG_UNAVAILABLE)
    await expect(call('get_entry_content', { id: locked.entry_id })).rejects.toThrow(
      MSG_UNAVAILABLE,
    )
    expect(await call('get_tags_for_entry', { entryId: locked.entry_id })).toEqual([])
  })

  it('filters favorites and by tag over the fetched pages', async () => {
    await setup()
    const fav = await call<PagedResult<Entry>>('list_favorite_entries_paged', {
      ...PAGE_ARGS,
      journalId: null,
      page: 1,
    })
    expect(titles(fav.items)).toEqual(['Golden two'])
    const tags = await call<Tag[]>('list_tags')
    const alpha = tags.find((t) => t.name === 'alpha')
    const byTag = await call<PagedResult<Entry>>('list_entries_by_tag_paged', {
      ...PAGE_ARGS,
      tagId: alpha?.id,
      journalId: null,
      favoritesOnly: false,
      page: 1,
    })
    expect(titles(byTag.items)).toEqual(['Golden two'])
  })
})

describe('single entries', () => {
  it('fetches an old entry on demand and returns its Yjs bytes as numbers', async () => {
    const { drive } = await setup({ pageSize: 2 })
    // "Golden one" is outside the 5 newest (updated_at 1700000000, the others 1791025173).
    const one = expected().find((e) => e.title === 'Golden one')
    if (!one) throw new Error('fixture')
    expect(await call('get_entry', { id: 'not-an-entry' })).toBeNull()
    expect(entryDownloads(drive)).toHaveLength(5)
    const entry = await call<Entry>('get_entry', { id: one.entry_id, activeVaultId: null })
    expect(entryDownloads(drive)).toHaveLength(6)
    expect(entry).toMatchObject({
      id: one.entry_id,
      title: 'Golden one',
      content_text: one.content_text,
      is_locked: false,
      media_count: 0,
    })
    const bytes = await call<number[]>('get_entry_content', { id: one.entry_id })
    expect(Array.isArray(bytes) && bytes.length > 0).toBe(true)
    expect(entryDownloads(drive)).toHaveLength(6)
    expect(mediaDownloads(drive)).toEqual([])
  })
})

describe('taxonomy', () => {
  it('lists the fixture journals, tags and templates read-only', async () => {
    const { drive } = await setup()
    const journals = await call<Journal[]>('list_journals')
    expect(journals.map((j) => j.name).sort()).toEqual(['Golden journal', 'My Journal'])
    for (const j of journals) {
      expect(j).toMatchObject({ is_deleted: false, is_locked: false, is_invisible: false })
      expect(await call('get_journal', { id: j.id })).toEqual(j)
    }
    expect(await call('get_journal', { id: 'missing' })).toBeNull()
    const tags = await call<Tag[]>('list_tags')
    expect(tags.map((t) => t.name)).toEqual(['alpha', 'beta'])
    await listAll(1)
    const counts = await call<Array<[Tag, number]>>('get_tags_with_counts')
    expect(counts.map(([t, n]) => [t.name, n])).toEqual([
      ['alpha', 1],
      ['beta', 1],
    ])
    const two = expected().find((e) => e.title === 'Golden two')
    const forEntry = await call<Tag[]>('get_tags_for_entry', { entryId: two?.entry_id })
    expect(forEntry.map((t) => t.name)).toEqual(['alpha', 'beta'])
    // The frozen fixture has no user templates (template parsing is covered in taxonomy.test.ts).
    expect(await call('list_templates')).toEqual([])
    expect(await call('get_template', { id: 'missing' })).toBeNull()
    expect(drive.mutating()).toEqual([])
  })
})

describe('search', () => {
  it('finds the Vietnamese entry with and without diacritics', async () => {
    await setup()
    await listAll(1)
    for (const q of ['bản ghi thứ năm', 'ban ghi thu nam', 'đây', 'day', 'DAY']) {
      expect(titles(await search(q)), q).toEqual(['Golden five'])
    }
    expect(await search('ba')).toEqual([]) // whole tokens, not prefixes
    expect(titles(await search('ba', { mentionMode: true }))).toEqual(['Golden five'])
  })

  it('pulls the remaining text payloads in the background: entries only, zero media', async () => {
    const { drive, emitted } = await setup()
    // Only the 5 warm-start payloads are loaded; the match is among the 2 not loaded yet.
    const before = await search('first')
    expect(before).toEqual([])
    await whenSearchScanSettled()
    expect(entryDownloads(drive)).toHaveLength(7)
    expect(new Set(entryDownloads(drive)).size).toBe(7)
    expect(mediaDownloads(drive)).toEqual([])
    expect(emitted).toEqual(['memlore:entries-changed'])
    expect(titles(await search('first'))).toEqual(['Golden one'])
    await whenSearchScanSettled()
    expect(entryDownloads(drive)).toHaveLength(7)
    expect(drive.mutating()).toEqual([])
  })

  it('cancel stops further background fetches', async () => {
    const { drive, onEntryGet } = await setup({ extraRows: 30 })
    // Warm start is 5 downloads; cancel while the first background batch (12 ids) is in flight.
    onEntryGet.current = (n) => {
      if (n === 6) cancelSearchScan()
    }
    await search('anything')
    await whenSearchScanSettled()
    const entries = entryDownloads(drive)
    expect(entries.length).toBe(5 + 12)
    expect(entries.length).toBeLessThan(5 + 2 + 30)
    expect(mediaDownloads(drive)).toEqual([])
    // Nothing more is fetched afterwards.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(entryDownloads(drive)).toHaveLength(5 + 12)
  })
})

describe('locked vault', () => {
  it('rejects every read handler once locked', async () => {
    const { drive } = await setup()
    await listAll(1)
    drive.requests.length = 0
    lock('manual')
    expect(isUnlocked()).toBe(false)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_entries_paged', { ...PAGE_ARGS, journalId: 'x', page: 1 }],
      ['list_all_entries_paged', { ...PAGE_ARGS, page: 1 }],
      ['list_favorite_entries_paged', { ...PAGE_ARGS, journalId: null, page: 1 }],
      ['list_entries_by_tag_paged', { ...PAGE_ARGS, tagId: 'x', journalId: null, page: 1 }],
      ['get_entry', { id: expected()[0].entry_id }],
      ['get_entry_content', { id: expected()[0].entry_id }],
      ['list_entry_dates', { journalId: null }],
      ['list_entries_for_date_range', { journalId: null, fromTs: 0, toTs: 1 }],
      ['list_on_this_day', { month: 1, day: 1 }],
      ['get_emotion_by_date', { year: 2026 }],
      ['count_entries_in_journal', { journalId: 'x' }],
      ['list_journals', {}],
      ['get_journal', { id: 'x' }],
      ['list_journal_auto_tags', { journalId: 'x' }],
      ['list_tags', {}],
      ['get_tags_with_counts', {}],
      ['get_tags_for_entry', { entryId: 'x' }],
      ['get_tags_for_entries', { entryIds: [] }],
      ['list_templates', {}],
      ['get_template', { id: 'x' }],
      ['search_entries', { query: 'golden' }],
    ]
    for (const [name, args] of calls) {
      await expect(call(name, args), name).rejects.toThrow('vault is locked')
    }
    expect(drive.requests).toEqual([])
  })
})
