import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EmotionTrendBucket,
  EntriesOverTimePoint,
  LocationPoint,
  MoodHistogramRow,
  MoodTrendPoint,
  StreakCalendarDay,
  TagFrequencyRow,
  WritingHourRow,
  WritingVolumePoint,
} from '../../../../src/lib/tauri'
import type { KeyRing } from '../keys'
import type { IndexEntry } from '../sync/entryIndex'
import { createMonthIndexReader } from '../sync/monthIndex'
import { indexStatsHandlers } from './indexStats'
import { configureReadEnv, type Taxonomy } from './readSession'
import { EMPTY_TAXONOMY, FakeVault, type FakeSpec } from './readTestKit'

const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'
const encoder = new TextEncoder()
const enc = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))
/** Unix seconds of a LOCAL wall-clock time (the desktop buckets with `'localtime'`). */
const local = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m - 1, d, h).getTime() / 1000
const NOW = local(2026, 6, 15)
const DAY = 86_400

interface RowSpec {
  id: string
  date: number
  emotion?: string | null
  words?: number
  tags?: string[]
  coords?: [number, number] | null
  /** EXIF `[latitude, longitude]` of one media item each. */
  exif?: Array<[number, number]>
  updatedAt?: number
}

const toRow = (r: RowSpec) => ({
  entry_id: r.id,
  updated_at: r.updatedAt ?? 100,
  entry_date: r.date,
  journal_id: 'j1',
  emotion: r.emotion === undefined ? null : r.emotion,
  is_favorite: false,
  tag_ids: r.tags ?? [],
  word_count: r.words ?? 0,
  title: null,
  preview_text: null,
  latitude: r.coords?.[0] ?? null,
  longitude: r.coords?.[1] ?? null,
  location_label: null,
  media: (r.exif ?? []).map(([lat, lng], i) => ({
    id: `${r.id}-m${i}`,
    file_name: 'f.jpg',
    file_type: 'image/jpeg',
    file_size: 1,
    sort_order: i,
    created_at: 1,
    insertion_mode: 'inline',
    width: null,
    height: null,
    duration_seconds: null,
    exif_date: null,
    exif_latitude: lat,
    exif_longitude: lng,
  })),
  versions: [],
})

function rig(
  rows: RowSpec[],
  options: { specs?: FakeSpec[]; withReader?: boolean; taxonomy?: Taxonomy } = {},
): { vault: FakeVault; index: Map<string, IndexEntry> } {
  const remote = new Map<string, Uint8Array>()
  const index = new Map<string, IndexEntry>()
  const byMonth = new Map<string, RowSpec[]>()
  for (const r of rows) {
    const month = new Date(r.date * 1000).toISOString().slice(0, 7)
    byMonth.set(month, [...(byMonth.get(month) ?? []), r])
    index.set(r.id, {
      entryId: r.id,
      authorDevice: SRC,
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
  const monthIndex = createMonthIndexReader({
    puller: {
      indexSource: SRC,
      pulls: 1,
      get index() {
        return index
      },
      readDeviceBin: async (path) => remote.get(path) ?? null,
    },
    db: {
      files: {
        get: async () => undefined,
        put: async () => undefined,
        delete: async () => undefined,
        paths: async () => [],
      },
    },
    core: { openDeviceBin: (_ring, bytes) => bytes },
    isJournalExcluded: () => false,
    isUnlocked: () => true,
    getKeyRing: () => ({}) as KeyRing,
  })
  const vault = new FakeVault(options.specs ?? [])
  configureReadEnv({
    isUnlocked: () => true,
    session: async () => ({
      vault,
      ...(options.withReader === false ? {} : { monthIndex }),
      ready: async () => options.taxonomy ?? EMPTY_TAXONOMY,
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
  })
  return { vault, index }
}

const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
  Promise.resolve(indexStatsHandlers[name](args)) as Promise<T>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})

afterEach(() => {
  vi.useRealTimers()
  configureReadEnv({})
})

describe('stats_entries_over_time', () => {
  it('counts per local day from the rolling cutoff, ascending, future entries included', async () => {
    rig([
      { id: 'a', date: local(2026, 6, 14, 23) },
      { id: 'b', date: local(2026, 6, 14, 1) },
      { id: 'c', date: local(2026, 6, 10) },
      { id: 'future', date: local(2026, 7, 2) },
      { id: 'old', date: NOW - 8 * DAY },
    ])
    const points = await call<EntriesOverTimePoint[]>('stats_entries_over_time', {
      period: 'day',
      range: 7,
    })
    expect(points).toEqual([
      { period_start: '2026-06-10', count: 1 },
      { period_start: '2026-06-14', count: 2 },
      { period_start: '2026-07-02', count: 1 },
    ])
  })

  it('buckets weeks like strftime %W (Monday first, days before the first Monday are week 00)', async () => {
    // 2026-01-01 is a Thursday: Jan 2 is week 00, Monday Jan 5 starts week 01.
    rig([
      { id: 'a', date: local(2026, 1, 2) },
      { id: 'b', date: local(2026, 1, 4) },
      { id: 'c', date: local(2026, 1, 5) },
      { id: 'd', date: local(2025, 12, 29) },
    ])
    const points = await call<EntriesOverTimePoint[]>('stats_entries_over_time', {
      period: 'week',
      range: 52,
    })
    expect(points).toEqual([
      { period_start: '2025-52', count: 1 },
      { period_start: '2026-00', count: 2 },
      { period_start: '2026-01', count: 1 },
    ])
  })

  it('treats any other period as months of 30 days', async () => {
    rig([
      { id: 'a', date: local(2026, 5, 31) },
      { id: 'b', date: local(2026, 6, 1) },
      { id: 'old', date: NOW - 61 * DAY },
    ])
    const points = await call<EntriesOverTimePoint[]>('stats_entries_over_time', {
      period: 'month',
      range: 2,
    })
    expect(points).toEqual([
      { period_start: '2026-05', count: 1 },
      { period_start: '2026-06', count: 1 },
    ])
  })

  it('rejects a range that is not a non-negative integer', async () => {
    rig([])
    await expect(call('stats_entries_over_time', { period: 'day', range: -1 })).rejects.toThrow(
      /range/,
    )
  })
})

describe('the vault rule', () => {
  it('never counts a refused entry and takes a loaded entry from its copy', async () => {
    const { vault } = rig(
      [
        { id: 'plain', date: local(2026, 6, 14), emotion: 'good', words: 4 },
        { id: 'locked', date: local(2026, 6, 14), emotion: 'bad', words: 9 },
        { id: 'loaded', date: local(2026, 6, 14), emotion: 'good', words: 50 },
      ],
      {
        specs: [
          { id: 'locked', updatedAt: 100, locked: true },
          {
            id: 'loaded',
            updatedAt: 100,
            entryDate: local(2026, 6, 13),
            emotion: 'neutral',
            text: 'three  short\nwords',
          },
        ],
      },
    )
    await vault.load(['locked', 'loaded'])
    const volume = await call<WritingVolumePoint[]>('stats_writing_volume', {
      period: 'day',
      range: 7,
    })
    expect(volume).toEqual([
      { period_start: '2026-06-13', total_words: 3, entry_count: 1 },
      { period_start: '2026-06-14', total_words: 4, entry_count: 1 },
    ])
    const moods = await call<MoodHistogramRow[]>('stats_mood_histogram', { rangeDays: 7 })
    expect(moods).toEqual([
      { emotion: 'good', count: 1 },
      { emotion: 'neutral', count: 1 },
    ])
  })

  it('answers the desktop empty shapes without a month index', async () => {
    rig([], { withReader: false })
    expect(await call('stats_entries_over_time', { period: 'day', range: 7 })).toEqual([])
    expect(await call('stats_tag_frequency')).toEqual([])
    expect(await call('stats_location_density')).toEqual([])
    const hours = await call<WritingHourRow[]>('stats_writing_hours', { rangeDays: 7 })
    expect(hours).toHaveLength(24)
    expect(hours.every((h) => h.count === 0)).toBe(true)
    const days = await call<StreakCalendarDay[]>('stats_streak_calendar', { year: 2026 })
    expect(days).toHaveLength(365)
  })
})

describe('emotion stats (bad / neutral / good only)', () => {
  const ROWS: RowSpec[] = [
    { id: 'a', date: local(2026, 6, 14), emotion: 'good' },
    { id: 'b', date: local(2026, 6, 14), emotion: 'bad' },
    { id: 'c', date: local(2026, 6, 14), emotion: 'good' },
    { id: 'd', date: local(2026, 6, 13), emotion: 'neutral' },
    { id: 'none', date: local(2026, 6, 13), emotion: null },
    { id: 'legacy', date: local(2026, 6, 13), emotion: 'ecstatic' },
    { id: 'old', date: NOW - 40 * DAY, emotion: 'bad' },
  ]

  it('histogram counts by emotion, most frequent first', async () => {
    rig(ROWS)
    expect(await call<MoodHistogramRow[]>('stats_mood_histogram', { rangeDays: 30 })).toEqual([
      { emotion: 'good', count: 2 },
      { emotion: 'bad', count: 1 },
      { emotion: 'neutral', count: 1 },
    ])
  })

  it('trend splits each day, and falls back to days for an unknown period', async () => {
    rig(ROWS)
    const expected: EmotionTrendBucket[] = [
      { period_start: '2026-06-13', bad_count: 0, neutral_count: 1, good_count: 0, total_count: 1 },
      { period_start: '2026-06-14', bad_count: 1, neutral_count: 0, good_count: 2, total_count: 3 },
    ]
    expect(await call('stats_emotion_trend', { period: 'day', rangeDays: 30 })).toEqual(expected)
    expect(await call('stats_emotion_trend', { period: 'month', rangeDays: 30 })).toEqual(expected)
  })

  it('mood trend counts emotion-tagged entries per local day', async () => {
    rig(ROWS)
    expect(await call<MoodTrendPoint[]>('stats_mood_trend', { rangeDays: 30 })).toEqual([
      { day: '2026-06-13', sample_count: 1 },
      { day: '2026-06-14', sample_count: 3 },
    ])
  })
})

describe('stats_writing_hours', () => {
  it('counts by local hour, all 24 hours zero-filled', async () => {
    rig([
      { id: 'a', date: local(2026, 6, 14, 7) },
      { id: 'b', date: local(2026, 6, 13, 7) },
      { id: 'c', date: local(2026, 6, 13, 23) },
      { id: 'old', date: NOW - 10 * DAY },
    ])
    const hours = await call<WritingHourRow[]>('stats_writing_hours', { rangeDays: 7 })
    expect(hours.map((h) => h.hour)).toEqual([...Array(24).keys()])
    expect(hours[7].count).toBe(2)
    expect(hours[23].count).toBe(1)
    expect(hours.reduce((sum, h) => sum + h.count, 0)).toBe(3)
  })
})

describe('stats_streak_calendar', () => {
  it('lists every local day of the year with its entry count (leap aware)', async () => {
    rig([
      { id: 'a', date: local(2024, 2, 29, 8) },
      { id: 'b', date: local(2024, 2, 29, 20) },
      { id: 'c', date: local(2024, 1, 1, 0) },
      { id: 'other-year', date: local(2023, 12, 31, 23) },
    ])
    const days = await call<StreakCalendarDay[]>('stats_streak_calendar', { year: 2024 })
    expect(days).toHaveLength(366)
    expect(days[0]).toEqual({ date: '2024-01-01', entry_count: 1 })
    expect(days.find((d) => d.date === '2024-02-29')).toEqual({
      date: '2024-02-29',
      entry_count: 2,
    })
    expect(days.reduce((sum, d) => sum + d.entry_count, 0)).toBe(3)
  })

  it('rejects a year out of range', async () => {
    rig([])
    await expect(call('stats_streak_calendar', { year: 999 })).rejects.toThrow(/year out of range/)
  })
})

describe('stats_tag_frequency', () => {
  it('counts entries per live tag with its name, most used first', async () => {
    rig(
      [
        { id: 'a', date: local(2020, 1, 1), tags: ['t1', 't2'] },
        { id: 'b', date: local(2026, 6, 1), tags: ['t2', 'gone'] },
      ],
      {
        taxonomy: {
          ...EMPTY_TAXONOMY,
          tags: [
            { id: 't1', name: 'travel', color: null },
            { id: 't2', name: 'work', color: null },
          ],
        },
      },
    )
    expect(await call<TagFrequencyRow[]>('stats_tag_frequency')).toEqual([
      { tag_id: 't2', tag_name: 'work', count: 2 },
      { tag_id: 't1', tag_name: 'travel', count: 1 },
    ])
  })
})

describe('stats_location_density', () => {
  it('rounds to 3 decimals and adds EXIF points only away from the entry location', async () => {
    rig([
      {
        id: 'a',
        date: local(2020, 1, 1),
        coords: [21.0284, 105.8541],
        exif: [[21.0284, 105.8541]],
      },
      { id: 'b', date: local(2026, 6, 1), coords: [21.02841, 105.85409] },
      { id: 'c', date: local(2026, 6, 2), coords: null, exif: [[-33.8676, 151.2076]] },
    ])
    const points = await call<LocationPoint[]>('stats_location_density')
    expect(points).toEqual([
      { lat: 21.028, lng: 105.854, count: 2 },
      { lat: -33.868, lng: 151.208, count: 1 },
    ])
  })
})
