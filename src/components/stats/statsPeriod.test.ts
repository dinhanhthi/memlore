import { describe, it, expect } from 'vitest'
import type { Period } from './PeriodSelector'
import {
  LOCATION_DENSITY_KEY,
  PERIOD_CONFIG,
  TAG_FREQUENCY_KEY,
  chartsCacheKeys,
  entriesOverTimeKey,
  moodHistogramKey,
  periodRangeDays,
  streakCalendarKey,
  writingVolumeKey,
} from './statsPeriod'

const ALL_PERIODS: Period[] = ['7d', '30d', '90d', '365d', 'all']

describe('statsPeriod', () => {
  it('maps every period to a bucket + range', () => {
    for (const period of ALL_PERIODS) {
      const { range, bucket } = PERIOD_CONFIG[period]
      expect(range).toBeGreaterThan(0)
      expect(['day', 'week', 'month']).toContain(bucket)
    }
  })

  it('derives range days from the period config', () => {
    for (const period of ALL_PERIODS) {
      expect(periodRangeDays(period)).toBe(PERIOD_CONFIG[period].range)
    }
  })

  // These strings are the contract between `ChartsGate`'s prefetch and each
  // chart's own `useStats` call — a drift here silently reintroduces the
  // double-skeleton bug, so pin the exact shape.
  it('builds the cache keys charts and the gate share', () => {
    expect(entriesOverTimeKey('30d')).toBe('entries_over_time:day:30')
    expect(entriesOverTimeKey('all')).toBe('entries_over_time:month:3650')
    expect(writingVolumeKey('90d')).toBe('writing_volume:week:90')
    expect(moodHistogramKey('7d')).toBe('mood_histogram:7')
    expect(streakCalendarKey(2026)).toBe('streak_calendar:2026')
    expect(TAG_FREQUENCY_KEY).toBe('tag_frequency')
    expect(LOCATION_DENSITY_KEY).toBe('location_density')
  })

  it('gives each period a distinct set of period-dependent keys', () => {
    const keys = ALL_PERIODS.map((p) => `${entriesOverTimeKey(p)}|${writingVolumeKey(p)}`)
    expect(new Set(keys).size).toBe(ALL_PERIODS.length)
  })

  it('lists every key the charts tab needs, without duplicates', () => {
    const keys = chartsCacheKeys('30d', 2026)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([
      entriesOverTimeKey('30d'),
      writingVolumeKey('30d'),
      moodHistogramKey('30d'),
      TAG_FREQUENCY_KEY,
      streakCalendarKey(2026),
      LOCATION_DENSITY_KEY,
    ])
  })
})
