import { afterEach, describe, expect, it } from 'vitest'
import type { Entry } from '../../../../src/types/entry'
import type { GalleryMediaRow } from '../../../../src/lib/tauri'
import type { PagedResult } from '../../../../src/types/pagination'
import type { KeyRing } from '../keys'
import type { FileRecord } from '../storage/idb'
import type { IndexEntry } from '../sync/entryIndex'
import { createMonthIndexReader, type MonthIndexReader } from '../sync/monthIndex'
import { indexViewHandlers } from './indexViews'
import { configureReadEnv } from './readSession'
import { EMPTY_TAXONOMY, FakeVault, type FakeSpec } from './readTestKit'

const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const encoder = new TextEncoder()
const enc = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))
const utc = (y: number, m: number, d: number, h = 12): number => Date.UTC(y, m - 1, d, h) / 1000

interface MediaSpec {
  id: string
  type?: string
  createdAt: number
  order?: number
}

interface RowSpec {
  id: string
  date: number
  updatedAt?: number
  journal?: string
  title?: string
  media?: MediaSpec[]
}

const monthOf = (secs: number): string => new Date(secs * 1000).toISOString().slice(0, 7)

const toRow = (r: RowSpec) => ({
  entry_id: r.id,
  updated_at: r.updatedAt ?? 100,
  entry_date: r.date,
  journal_id: r.journal ?? 'j1',
  emotion: 'good',
  is_favorite: true,
  tag_ids: ['t1'],
  word_count: 3,
  title: r.title ?? `title ${r.id}`,
  preview_text: `preview ${r.id}`,
  latitude: 1.5,
  longitude: 2.5,
  location_label: 'Hanoi',
  media: (r.media ?? []).map((m) => ({
    id: m.id,
    file_name: 'f.bin',
    file_type: m.type ?? 'image/jpeg',
    file_size: 10,
    sort_order: m.order ?? 0,
    created_at: m.createdAt,
    insertion_mode: 'inline',
    width: 4,
    height: 3,
    duration_seconds: m.type?.startsWith('audio/') ? 23 : null,
    exif_date: null,
    exif_latitude: null,
    exif_longitude: null,
  })),
  versions: [],
})

interface Rig {
  reads: string[]
  index: Map<string, IndexEntry>
  excluded: Set<string>
  vault: FakeVault
  setUnlocked: (v: boolean) => void
}

/**
 * A real month index reader over a fake puller (`openDeviceBin` is the identity). Every row's
 * entry is a live index winner at `updated_at` unless the test changes `index`.
 */
function rig(
  rows: RowSpec[],
  options: { source?: string | null; withReader?: boolean; specs?: FakeSpec[] } = {},
): Rig {
  const remote = new Map<string, Uint8Array>()
  const files = new Map<string, FileRecord>()
  const reads: string[] = []
  const index = new Map<string, IndexEntry>()
  const excluded = new Set<string>()
  let unlocked = true
  const byMonth = new Map<string, RowSpec[]>()
  for (const r of rows) {
    const month = monthOf(r.date)
    byMonth.set(month, [...(byMonth.get(month) ?? []), r])
    index.set(r.id, {
      entryId: r.id,
      authorDevice: OTHER,
      updatedAt: r.updatedAt ?? 100,
      isDeleted: false,
    })
  }
  remote.set(
    `${SRC}/index/months.bin`,
    enc({
      schema_version: 1,
      device_id: SRC,
      generated_at: 1,
      months: [...byMonth.keys()].map((month) => ({ month, hash_hex: `h-${month}` })),
    }),
  )
  for (const [month, list] of byMonth) {
    remote.set(
      `${SRC}/index/${month}.bin`,
      enc({ schema_version: 1, device_id: SRC, month, generated_at: 1, rows: list.map(toRow) }),
    )
  }
  const source = options.source === undefined ? SRC : options.source
  const monthIndex: MonthIndexReader = createMonthIndexReader({
    puller: {
      indexSource: source,
      pulls: 1,
      get index() {
        return index
      },
      readDeviceBin: async (path) => {
        reads.push(path)
        return remote.get(path) ?? null
      },
    },
    db: {
      files: {
        get: async (path) => files.get(path),
        put: async (record) => {
          files.set(record.path, record)
        },
        delete: async (path) => {
          files.delete(path)
        },
        paths: async () => [...files.keys()],
      },
    },
    core: { openDeviceBin: (_ring, bytes) => bytes },
    isJournalExcluded: (journalId) => excluded.has(journalId),
    isUnlocked: () => unlocked,
    getKeyRing: () => ({}) as KeyRing,
  })
  const vault = new FakeVault(options.specs ?? [])
  configureReadEnv({
    isUnlocked: () => unlocked,
    session: async () => ({
      vault,
      ...(options.withReader === false ? {} : { monthIndex }),
      ready: async () => EMPTY_TAXONOMY,
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
  })
  return {
    reads,
    index,
    excluded,
    vault,
    setUnlocked: (v) => {
      unlocked = v
    },
  }
}

const call = <T>(name: string, args: Record<string, unknown>): Promise<T> =>
  Promise.resolve(indexViewHandlers[name](args)) as Promise<T>

const gallery = (page: number, pageSize: number, kind: string | null = null) =>
  call<PagedResult<GalleryMediaRow>>('list_all_media_paged', {
    kind,
    page,
    pageSize,
    lockedView: 'revealed',
    activeVaultId: null,
  })

afterEach(() => {
  configureReadEnv({})
})

describe('list_on_this_day', () => {
  const ROWS: RowSpec[] = [
    { id: 'a', date: utc(2024, 3, 5) },
    { id: 'b', date: utc(2022, 3, 5, 3) },
    { id: 'c', date: utc(2025, 3, 5, 20) },
    { id: 'other-day', date: utc(2024, 3, 6) },
    { id: 'other-month', date: utc(2024, 4, 5) },
  ]

  it('answers across years from only the months of that UTC month, newest first', async () => {
    const r = rig(ROWS)
    const hits = await call<Entry[]>('list_on_this_day', { month: 3, day: 5 })
    expect(hits.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    expect(r.reads).not.toContain(`${SRC}/index/2024-04.bin`)
    expect(r.reads).toContain(`${SRC}/index/2024-03.bin`)
  })

  it('maps an index row to the desktop Entry shape', async () => {
    rig([{ id: 'a', date: utc(2024, 3, 5), media: [{ id: 'm2', createdAt: 1, order: 1 }] }])
    const [entry] = await call<Entry[]>('list_on_this_day', { month: 3, day: 5 })
    expect(entry).toMatchObject({
      id: 'a',
      journal_id: 'j1',
      title: 'title a',
      preview_text: 'preview a',
      entry_date: utc(2024, 3, 5),
      updated_at: 100,
      emotion: 'good',
      is_favorite: true,
      latitude: 1.5,
      longitude: 2.5,
      location_label: 'Hanoi',
      is_locked: false,
      is_invisible: false,
      is_deleted: false,
      media_count: 1,
      cover_media_id: 'm2',
    })
  })

  it('picks the first image as the cover, before any video (desktop rule)', async () => {
    rig([
      {
        id: 'a',
        date: utc(2024, 3, 5),
        media: [
          { id: 'clip', type: 'video/mp4', createdAt: 1, order: 0 },
          { id: 'photo', createdAt: 2, order: 1 },
        ],
      },
    ])
    const [entry] = await call<Entry[]>('list_on_this_day', { month: 3, day: 5 })
    expect(entry.cover_media_id).toBe('photo')
  })

  it('leaves out stale, trashed and excluded-journal rows', async () => {
    const r = rig([
      { id: 'a', date: utc(2024, 3, 5) },
      { id: 'stale', date: utc(2023, 3, 5) },
      { id: 'trashed', date: utc(2022, 3, 5) },
      { id: 'hidden', date: utc(2021, 3, 5), journal: 'locked-journal' },
    ])
    r.index.set('stale', {
      entryId: 'stale',
      authorDevice: OTHER,
      updatedAt: 999,
      isDeleted: false,
    })
    r.index.set('trashed', {
      entryId: 'trashed',
      authorDevice: OTHER,
      updatedAt: 100,
      isDeleted: false,
      trashedAt: 50,
    })
    r.excluded.add('locked-journal')
    const hits = await call<Entry[]>('list_on_this_day', { month: 3, day: 5 })
    expect(hits.map((e) => e.id)).toEqual(['a'])
  })

  it('prefers the loaded entry (web edits) and drops one the vault refuses', async () => {
    const r = rig(
      [
        { id: 'a', date: utc(2024, 3, 5) },
        { id: 'b', date: utc(2023, 3, 5) },
      ],
      {
        specs: [
          { id: 'a', updatedAt: 100, entryDate: utc(2024, 3, 5), title: 'edited on web' },
          { id: 'b', updatedAt: 100, entryDate: utc(2023, 3, 5), locked: true },
        ],
      },
    )
    await r.vault.load(['a', 'b'])
    const hits = await call<Entry[]>('list_on_this_day', { month: 3, day: 5 })
    expect(hits.map((e) => [e.id, e.title])).toEqual([['a', 'edited on web']])
  })

  it('validates month and day', async () => {
    rig(ROWS)
    await expect(call('list_on_this_day', { month: 13, day: 1 })).rejects.toThrow('month must be')
    await expect(call('list_on_this_day', { month: 1, day: 0 })).rejects.toThrow('day must be')
  })

  it('is empty without an index source or reader', async () => {
    rig(ROWS, { source: null })
    expect(await call('list_on_this_day', { month: 3, day: 5 })).toEqual([])
    rig(ROWS, { withReader: false })
    expect(await call('list_on_this_day', { month: 3, day: 5 })).toEqual([])
  })
})

describe('list_all_media_paged', () => {
  const ROWS: RowSpec[] = [
    {
      id: 'old-entry',
      date: utc(2020, 1, 10),
      // An old entry with a recent photo still sorts by the media's own created_at.
      media: [{ id: 'm-new', createdAt: 900 }],
    },
    {
      id: 'e1',
      date: utc(2026, 9, 1),
      media: [
        { id: 'm-a', createdAt: 500 },
        { id: 'm-b', type: 'video/mp4', createdAt: 500 },
        { id: 'doc', type: 'application/pdf', createdAt: 800 },
      ],
    },
    {
      id: 'e2',
      date: utc(2025, 5, 1),
      media: [
        { id: 'm-c', type: 'audio/mp4', createdAt: 300 },
        { id: '../evil', createdAt: 700 },
      ],
    },
  ]

  it('pages media newest first (created_at, then id) with the desktop row shape', async () => {
    rig(ROWS)
    const first = await gallery(1, 2)
    expect(first.total).toBe(4)
    expect(first.items.map((m) => m.id)).toEqual(['m-new', 'm-b'])
    expect(first.items[0]).toEqual({
      id: 'm-new',
      entryId: 'old-entry',
      journalId: 'j1',
      fileType: 'image/jpeg',
      storagePath: 'memlore-web://media/m-new',
      thumbnailPath: 'memlore-web://media/m-new.thumb',
      cloudPath: null,
      uploadStatus: 'uploaded',
      createdAt: 900,
      entryDate: utc(2020, 1, 10),
      durationSeconds: null,
      entryTitle: 'title old-entry',
      entryPreview: 'preview old-entry',
    })
    const second = await gallery(2, 2)
    expect(second.items.map((m) => m.id)).toEqual(['m-a', 'm-c'])
    expect(second.items[1]).toMatchObject({ thumbnailPath: null, durationSeconds: 23 })
    expect((await gallery(3, 2)).items).toEqual([])
  })

  it('filters by kind', async () => {
    rig(ROWS)
    const videos = await gallery(1, 20, 'video')
    expect(videos).toEqual(expect.objectContaining({ total: 1 }))
    expect(videos.items.map((m) => m.id)).toEqual(['m-b'])
  })

  it('leaves out media of stale and excluded-journal entries', async () => {
    const r = rig(ROWS)
    r.index.set('old-entry', {
      entryId: 'old-entry',
      authorDevice: OTHER,
      updatedAt: 101,
      isDeleted: false,
    })
    r.index.set('e2', { entryId: 'e2', authorDevice: OTHER, updatedAt: 100, isDeleted: true })
    const page = await gallery(1, 20)
    expect(page.items.map((m) => m.id)).toEqual(['m-b', 'm-a'])
    expect(page.total).toBe(2)
  })

  it('leaves out media of an entry the vault refuses (locked once loaded)', async () => {
    const r = rig(ROWS, {
      specs: [{ id: 'e1', updatedAt: 100, entryDate: utc(2026, 9, 1), locked: true }],
    })
    await r.vault.load(['e1'])
    const page = await gallery(1, 20)
    expect(page.items.map((m) => m.id)).toEqual(['m-new', 'm-c'])
    expect(page.total).toBe(2)
  })

  it('serves a loaded entry from the vault: no media its copy tombstoned, its own title', async () => {
    const r = rig(
      [
        {
          id: 'e1',
          date: utc(2026, 9, 1),
          media: [
            { id: 'm0', createdAt: 500 },
            { id: 'm1', createdAt: 400 },
          ],
        },
      ],
      {
        specs: [
          {
            id: 'e1',
            updatedAt: 100,
            entryDate: utc(2026, 9, 1),
            title: 'edited on web',
            media: 2,
            deletedMedia: ['m0'],
          },
        ],
      },
    )
    await r.vault.load(['e1'])
    const page = await gallery(1, 20)
    expect(page.total).toBe(1)
    expect(page.items.map((m) => [m.id, m.entryTitle])).toEqual([['m1', 'edited on web']])
  })

  it('is empty without an index source or reader', async () => {
    rig(ROWS, { source: null })
    expect(await gallery(1, 20)).toEqual({ items: [], total: 0 })
    rig(ROWS, { withReader: false })
    expect(await gallery(1, 20)).toEqual({ items: [], total: 0 })
  })
})

describe('locked vault', () => {
  it('rejects both handlers and reads nothing', async () => {
    const r = rig([{ id: 'a', date: utc(2024, 3, 5) }])
    r.setUnlocked(false)
    await expect(call('list_on_this_day', { month: 3, day: 5 })).rejects.toThrow('vault is locked')
    await expect(gallery(1, 20)).rejects.toThrow('vault is locked')
    expect(r.reads).toEqual([])
  })
})
