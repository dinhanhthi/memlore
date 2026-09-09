import type { Period } from './PeriodSelector'

/** Aggregation bucket the backend stats commands accept. */
export type StatsBucket = 'day' | 'week' | 'month'

/**
 * Bucket + range each UI period maps to when calling the backend stats
 * commands, plus the `useStats` cache keys built from them.
 *
 * Single source of truth: `ChartsGate` prefetches with these exact keys so the
 * charts it gates find their data already cached and mount without a second
 * per-chart placeholder. A drifting key here would silently reintroduce that
 * double-loading state, so every chart imports from this module.
 */
export const PERIOD_CONFIG: Record<Period, { range: number; bucket: StatsBucket }> = {
  '7d': { range: 7, bucket: 'day' },
  '30d': { range: 30, bucket: 'day' },
  '90d': { range: 90, bucket: 'week' },
  '365d': { range: 365, bucket: 'week' },
  all: { range: 3650, bucket: 'month' },
}

/**
 * Day count for the bucket-less commands (mood histogram). Derived from
 * `PERIOD_CONFIG` rather than a second table so the two can never drift.
 */
export function periodRangeDays(period: Period): number {
  return PERIOD_CONFIG[period].range
}

export function entriesOverTimeKey(period: Period): string {
  const { range, bucket } = PERIOD_CONFIG[period]
  return `entries_over_time:${bucket}:${range}`
}

/** Shared by `WritingVolumeChart` and `WordCountBox` — same command, same cache. */
export function writingVolumeKey(period: Period): string {
  const { range, bucket } = PERIOD_CONFIG[period]
  return `writing_volume:${bucket}:${range}`
}

export function moodHistogramKey(period: Period): string {
  return `mood_histogram:${periodRangeDays(period)}`
}

export function streakCalendarKey(year: number): string {
  return `streak_calendar:${year}`
}

export const TAG_FREQUENCY_KEY = 'tag_frequency'
export const LOCATION_DENSITY_KEY = 'location_density'

/** Every cache key the Charts tab needs before it can render without placeholders. */
export function chartsCacheKeys(period: Period, year: number): string[] {
  return [
    entriesOverTimeKey(period),
    writingVolumeKey(period),
    moodHistogramKey(period),
    TAG_FREQUENCY_KEY,
    streakCalendarKey(year),
    LOCATION_DENSITY_KEY,
  ]
}
