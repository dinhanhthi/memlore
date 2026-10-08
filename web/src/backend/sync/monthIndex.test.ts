import { describe, expect, it } from 'vitest'
import { VaultLockedError, type KeyRing } from '../keys'
import type { FileRecord } from '../storage/idb'
import type { IndexEntry } from './entryIndex'
import {
  createMonthIndexReader,
  utcMonthsCovering,
  utcMonthsForLocalMonth,
  type MonthIndexDeps,
} from './monthIndex'
import { PullTransientError } from './pull'

const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const E1 = 'e1111111-0000-4000-8000-000000000001'
const E2 = 'e2222222-0000-4000-8000-000000000002'
const E3 = 'e3333333-0000-4000-8000-000000000003'
const encoder = new TextEncoder()
const enc = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))

class Gate {
  readonly promise: Promise<void>
  open!: () => void
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }
}

const catalog = (months: Record<string, string>, device = SRC) => ({
  schema_version: 1,
  device_id: device,
  generated_at: 1,
  months: Object.entries(months).map(([month, hash_hex]) => ({ month, hash_hex, row_count: 1 })),
})

const row = (entry_id: string, updated_at: number, journal_id = 'j1') => ({
  entry_id,
  updated_at,
  entry_date: 1_790_000_000,
  journal_id,
  emotion: 'good',
  is_favorite: false,
  tag_ids: ['t1'],
  word_count: 3,
  title: `title ${entry_id.slice(0, 2)}`,
  preview_text: 'preview',
  latitude: null,
  longitude: null,
  location_label: null,
  media: [],
  versions: [],
})

const monthFile = (month: string, rows: unknown[], device = SRC) => ({
  schema_version: 1,
  device_id: device,
  month,
  generated_at: 1,
  rows,
})

const live = (entryId: string, updatedAt: number, extra: Partial<IndexEntry> = {}): IndexEntry => ({
  entryId,
  authorDevice: SRC,
  updatedAt,
  isDeleted: false,
  ...extra,
})

/** Fake puller + `files` store: `openDeviceBin` is the identity, so a sealed bin is its JSON. */
function harness() {
  const files = new Map<string, FileRecord>()
  const remote = new Map<string, Uint8Array | 'oversize' | Error>()
  const reads: string[] = []
  const state = {
    unlocked: true,
    pulls: 1,
    source: SRC as string | null,
    hold: undefined as Gate | undefined,
    index: new Map<string, IndexEntry>(),
    excluded: new Set<string>(),
  }
  const deps: MonthIndexDeps = {
    puller: {
      get indexSource() {
        return state.source
      },
      get pulls() {
        return state.pulls
      },
      get index() {
        return state.index
      },
      readDeviceBin: async (path) => {
        if (!state.unlocked) throw new VaultLockedError()
        reads.push(path)
        await state.hold?.promise
        if (!state.unlocked) throw new VaultLockedError()
        const value = remote.get(path)
        if (value instanceof Error) throw value
        return value ?? null
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
    isJournalExcluded: (journalId) => state.excluded.has(journalId),
    isUnlocked: () => state.unlocked,
    getKeyRing: () => ({}) as KeyRing,
  }
  const setCatalog = (months: Record<string, string>, device = SRC): void => {
    remote.set(`${device}/index/months.bin`, enc(catalog(months, device)))
  }
  const setMonth = (month: string, rows: unknown[], device = SRC): void => {
    remote.set(`${device}/index/${month}.bin`, enc(monthFile(month, rows, device)))
  }
  return { deps, files, remote, reads, state, setCatalog, setMonth }
}

describe('getMonths', () => {
  it('fetches a month on demand once, then serves it from the cache', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9', '2026-10': 'h10' })
    h.setMonth('2026-09', [row(E1, 100)])
    h.setMonth('2026-10', [row(E2, 200)])
    h.state.index.set(E1, live(E1, 100))
    const reader = createMonthIndexReader(h.deps)

    const first = await reader.getMonths(['2026-09'])
    expect(first.rows.map((r) => r.entry_id)).toEqual([E1])
    expect(first.degraded).toEqual([])
    expect(h.reads).toEqual([`${SRC}/index/months.bin`, `${SRC}/index/2026-09.bin`])
    expect(h.files.get(`${SRC}/index/2026-09.bin`)?.etag).toBe('h9')
    expect(h.files.has(`${SRC}/index/2026-10.bin`)).toBe(false)

    h.reads.length = 0
    await reader.getMonths(['2026-09'])
    expect(h.reads).toEqual([])

    // A reload (new reader, same IndexedDB) re-reads only the catalog.
    const reloaded = createMonthIndexReader(h.deps)
    expect((await reloaded.getMonths(['2026-09'])).rows.map((r) => r.entry_id)).toEqual([E1])
    expect(h.reads).toEqual([`${SRC}/index/months.bin`])
  })

  it('refetches only months whose catalog hash changed and drops unlisted ones', async () => {
    const h = harness()
    h.setCatalog({ '2026-08': 'h8', '2026-09': 'h9', '2026-10': 'h10' })
    h.setMonth('2026-08', [row(E3, 50)])
    h.setMonth('2026-09', [row(E1, 100)])
    h.setMonth('2026-10', [row(E2, 200)])
    h.state.index.set(E1, live(E1, 101))
    h.state.index.set(E2, live(E2, 200))
    const reader = createMonthIndexReader(h.deps)
    await reader.getMonths(['2026-08', '2026-09', '2026-10'])
    expect(h.files.has(`${SRC}/index/2026-08.bin`)).toBe(true)

    h.state.pulls += 1
    h.setCatalog({ '2026-09': 'h9b', '2026-10': 'h10' })
    h.setMonth('2026-09', [row(E1, 101)])
    h.reads.length = 0
    await reader.revalidate()
    expect(h.reads).toEqual([`${SRC}/index/months.bin`])
    expect(h.files.has(`${SRC}/index/2026-08.bin`)).toBe(false)
    expect(h.files.has(`${SRC}/index/2026-09.bin`)).toBe(false)

    const got = await reader.getMonths(['2026-09', '2026-10'])
    expect(h.reads).toEqual([`${SRC}/index/months.bin`, `${SRC}/index/2026-09.bin`])
    expect(got.rows.map((r) => r.entry_id).sort()).toEqual([E1, E2].sort())
    expect(h.files.get(`${SRC}/index/2026-09.bin`)?.etag).toBe('h9b')
  })

  it('drops the cached months of a previous index source', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [row(E1, 100)])
    const reader = createMonthIndexReader(h.deps)
    await reader.getMonths(['2026-09'])
    h.state.source = OTHER
    h.state.pulls += 1
    h.setCatalog({ '2026-09': 'o9' }, OTHER)
    await reader.revalidate()
    expect([...h.files.keys()].filter((p) => p.startsWith(`${SRC}/`))).toEqual([])
  })

  it('hides a stale row (updated_at differs from the winner) until the index confirms it', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [row(E1, 100), row(E2, 200)])
    h.state.index.set(E1, live(E1, 150))
    h.state.index.set(E2, live(E2, 200))
    const reader = createMonthIndexReader(h.deps)
    const got = await reader.getMonths(['2026-09'])
    expect(got.rows.map((r) => r.entry_id)).toEqual([E2])
    expect(got.unconfirmed).toEqual([E1])

    h.state.index.set(E1, live(E1, 100))
    const later = await reader.getMonths(['2026-09'])
    expect(later.rows.map((r) => r.entry_id)).toEqual([E1, E2])
    expect(later.unconfirmed).toEqual([])

    // Listed in two months (its date moved): the row that matches the winner is the one shown.
    h.state.pulls += 1
    h.setCatalog({ '2026-08': 'h8', '2026-09': 'h9' })
    h.setMonth('2026-08', [row(E1, 150)])
    h.state.index.set(E1, live(E1, 150))
    const moved = await reader.getMonths(['2026-09', '2026-08'])
    expect(moved.rows.map((r) => [r.entry_id, r.updated_at])).toEqual([
      [E2, 200],
      [E1, 150],
    ])
    expect(moved.unconfirmed).toEqual([])
  })

  it('drops rows of deleted, trashed, unknown or excluded-journal entries', async () => {
    const h = harness()
    const E4 = 'e4444444-0000-4000-8000-000000000004'
    const E5 = 'e5555555-0000-4000-8000-000000000005'
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [
      row(E1, 100),
      row(E2, 100),
      row(E3, 100, 'locked-journal'),
      row(E4, 100),
      row(E5, 100),
    ])
    h.state.index.set(E1, live(E1, 100, { isDeleted: true }))
    h.state.index.set(E2, live(E2, 100, { trashedAt: 99 }))
    h.state.index.set(E3, live(E3, 100))
    h.state.index.set(E5, live(E5, 100))
    h.state.excluded.add('locked-journal')
    const got = await createMonthIndexReader(h.deps).getMonths(['2026-09'])
    expect(got.rows.map((r) => r.entry_id)).toEqual([E5])
    expect(got.unconfirmed).toEqual([])
  })

  it('stops on a lock mid-fetch and caches nothing', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [row(E1, 100)])
    h.state.index.set(E1, live(E1, 100))
    const reader = createMonthIndexReader(h.deps)
    await reader.revalidate()
    const gate = new Gate()
    h.state.hold = gate
    const pending = reader.getMonths(['2026-09'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.state.unlocked = false
    reader.clear()
    gate.open()
    await expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    expect(h.files.has(`${SRC}/index/2026-09.bin`)).toBe(false)
  })

  it('a garbage, missing or unreadable month is degraded, never fatal', async () => {
    const h = harness()
    h.setCatalog({
      '2026-06': 'h6',
      '2026-07': 'h7',
      '2026-08': 'h8',
      '2026-09': 'h9',
      '2026-10': 'h10',
    })
    h.remote.set(`${SRC}/index/2026-07.bin`, encoder.encode('not json'))
    h.remote.set(`${SRC}/index/2026-08.bin`, new PullTransientError('flaky'))
    h.setMonth('2026-09', [row(E1, 100)])
    // Another device's month file under the source's path is not trusted.
    h.remote.set(`${SRC}/index/2026-10.bin`, enc(monthFile('2026-10', [row(E2, 100)], OTHER)))
    h.state.index.set(E1, live(E1, 100))
    h.state.index.set(E2, live(E2, 100))
    const got = await createMonthIndexReader(h.deps).getMonths([
      '2026-06', // listed but missing on the cloud
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11', // not in the catalog: an empty month, not degraded
    ])
    expect(got.rows.map((r) => r.entry_id)).toEqual([E1])
    expect(got.degraded.sort()).toEqual(['2026-06', '2026-07', '2026-08', '2026-10'])
    expect(h.files.has(`${SRC}/index/2026-07.bin`)).toBe(false)
  })

  it('skips malformed rows and keeps the well-typed ones', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [
      { entry_id: 7, updated_at: 100 },
      { entry_id: '../x', updated_at: 100 },
      { entry_id: E2 },
      // A row without a journal id cannot be checked against the journal exclusion: dropped.
      { entry_id: E2, updated_at: 100 },
      { entry_id: E3, updated_at: 100, journal_id: '' },
      { entry_id: E3, updated_at: 100, journal_id: 42 },
      { entry_id: E1, updated_at: 100, journal_id: 'j1', tag_ids: ['t', 3], title: 5, media: 'no' },
    ])
    h.state.index.set(E1, live(E1, 100))
    h.state.index.set(E2, live(E2, 100))
    h.state.index.set(E3, live(E3, 100))
    const got = await createMonthIndexReader(h.deps).getMonths(['2026-09'])
    expect(got.unconfirmed).toEqual([])
    expect(got.rows).toHaveLength(1)
    expect(got.rows[0]).toMatchObject({ entry_id: E1, tag_ids: ['t'], title: null, media: [] })
  })

  it('without an index source or catalog every requested month is degraded', async () => {
    const h = harness()
    h.state.source = null
    const reader = createMonthIndexReader(h.deps)
    expect((await reader.getMonths(['2026-09'])).degraded).toEqual(['2026-09'])
    expect(h.reads).toEqual([])

    h.state.source = SRC
    h.state.pulls += 1
    h.remote.set(`${SRC}/index/months.bin`, encoder.encode('garbage'))
    expect((await reader.getMonths(['2026-09'])).degraded).toEqual(['2026-09'])
  })
})

describe('listMonths', () => {
  it('lists the catalog months newest first, without fetching any month', async () => {
    const h = harness()
    h.setCatalog({ '2025-01': 'a', '2026-10': 'b', '2026-02': 'c' })
    const reader = createMonthIndexReader(h.deps)
    expect(await reader.listMonths()).toEqual(['2026-10', '2026-02', '2025-01'])
    expect(h.reads).toEqual([`${SRC}/index/months.bin`])
  })

  it('is empty without an index source or a readable catalog', async () => {
    const h = harness()
    h.state.source = null
    const reader = createMonthIndexReader(h.deps)
    expect(await reader.listMonths()).toEqual([])
    h.state.source = SRC
    h.state.pulls += 1
    expect(await reader.listMonths()).toEqual([])
  })
})

describe('findMedia', () => {
  const MEDIA = 'f0000000-0000-4000-8000-00000000000f'
  const withMedia = (entryId: string, updatedAt: number, journalId = 'j1', id = MEDIA) => ({
    ...row(entryId, updatedAt, journalId),
    media: [{ id, file_name: 'a.jpg', file_type: 'image/jpeg', file_size: 9, width: 4, height: 3 }],
  })

  it('finds media of a month already read, with the winner as author device', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [withMedia(E1, 100)])
    h.state.index.set(E1, live(E1, 100, { authorDevice: OTHER }))
    const reader = createMonthIndexReader(h.deps)
    expect(reader.findMedia(MEDIA)).toBeNull() // nothing read yet: no download
    await reader.getMonths(['2026-09'])
    const found = reader.findMedia(MEDIA)
    expect(found?.entryId).toBe(E1)
    expect(found?.authorDevice).toBe(OTHER)
    expect(found?.media.file_type).toBe('image/jpeg')
  })

  it('applies the fail-closed rule: stale, trashed or excluded rows are not found', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [withMedia(E1, 100)])
    h.state.index.set(E1, live(E1, 100))
    const reader = createMonthIndexReader(h.deps)
    await reader.getMonths(['2026-09'])
    expect(reader.findMedia(MEDIA)).not.toBeNull()

    h.state.index.set(E1, live(E1, 150))
    expect(reader.findMedia(MEDIA)).toBeNull()
    h.state.index.set(E1, live(E1, 100, { trashedAt: 120 }))
    expect(reader.findMedia(MEDIA)).toBeNull()
    h.state.index.set(E1, live(E1, 100))
    h.state.excluded.add('j1')
    expect(reader.findMedia(MEDIA)).toBeNull()
    h.state.excluded.clear()
    h.state.unlocked = false
    expect(reader.findMedia(MEDIA)).toBeNull()
  })

  it('never returns an unsafe media id and forgets everything on clear', async () => {
    const h = harness()
    h.setCatalog({ '2026-09': 'h9' })
    h.setMonth('2026-09', [withMedia(E1, 100, 'j1', '../x'), withMedia(E2, 100)])
    h.state.index.set(E1, live(E1, 100))
    h.state.index.set(E2, live(E2, 100))
    const reader = createMonthIndexReader(h.deps)
    await reader.getMonths(['2026-09'])
    expect(reader.findMedia('../x')).toBeNull()
    expect(reader.findMedia(MEDIA)?.entryId).toBe(E2)
    reader.clear()
    expect(reader.findMedia(MEDIA)).toBeNull()
  })
})

describe('UTC month keys for local-time views', () => {
  it('lists every UTC month a [from, to) range touches', () => {
    const oct1 = Date.UTC(2026, 9, 1) / 1000
    expect(utcMonthsCovering(oct1 - 7 * 3600, oct1 + 3600)).toEqual(['2026-09', '2026-10'])
    expect(utcMonthsCovering(oct1, oct1 + 3600)).toEqual(['2026-10'])
    const jan1 = Date.UTC(2027, 0, 1) / 1000
    expect(utcMonthsCovering(jan1 - 3600, jan1 + 3600)).toEqual(['2026-12', '2027-01'])
    expect(utcMonthsCovering(oct1, oct1)).toEqual([])
  })

  it('a local month maps to itself plus at most one adjacent UTC month', () => {
    const keys = utcMonthsForLocalMonth('2026-10')
    expect(keys).toContain('2026-10')
    expect(keys.every((k) => ['2026-09', '2026-10', '2026-11'].includes(k))).toBe(true)
    expect(keys.length).toBeLessThanOrEqual(2)
    expect(utcMonthsForLocalMonth('garbage')).toEqual([])
  })
})
