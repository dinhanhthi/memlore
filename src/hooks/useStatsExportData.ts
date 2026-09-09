/**
 * useStatsExportData — fetch every stats dataset behind the Charts tab
 * in one shot so the export modal can serialize them on demand.
 *
 * Loaded lazily (on first call to `load()`) rather than on mount —
 * the Statistics view itself shouldn't pay this cost until the user
 * actually opens the export modal.
 */

import { useCallback, useState } from 'react'
import {
  statsEntriesOverTime,
  statsLocationDensity,
  statsMoodHistogram,
  statsMoodTrend,
  statsStreakCalendar,
  statsTagFrequency,
  statsWritingVolume,
  type EntriesOverTimePoint,
  type LocationPoint,
  type MoodHistogramRow,
  type MoodTrendPoint,
  type StreakCalendarDay,
  type TagFrequencyRow,
  type WritingVolumePoint,
} from '../lib/tauri'

/** Single bundle wrapping every chart's raw data.  The shape mirrors
 *  the order in which charts are rendered on the Charts tab so the
 *  CSV files and HTML sections stay visually predictable. */
export interface StatsChartsBundle {
  /** Range used for the time-series charts (entries over time + writing volume).
   *  Captured so the JSON / HTML headers can explain "what does this 30 mean?". */
  rangeDays: number
  /** Year used for the streak calendar — `new Date().getFullYear()`. */
  streakYear: number
  entries_over_time: EntriesOverTimePoint[]
  writing_volume: WritingVolumePoint[]
  mood_histogram: MoodHistogramRow[]
  mood_trend: MoodTrendPoint[]
  tag_frequency: TagFrequencyRow[]
  streak_calendar: StreakCalendarDay[]
  location_density: LocationPoint[]
}

export interface UseStatsExportDataReturn {
  data: StatsChartsBundle | null
  loading: boolean
  error: string | null
  /** Force a fresh fetch. Resolves to the bundle on success and
   *  throws on error (so the caller can wrap in try/catch). */
  load: () => Promise<StatsChartsBundle>
}

/**
 * The chart components themselves accept `period: '7d' | '30d' | '90d' | 'all'`
 * and translate it into `(period, range)` arguments to the Rust commands.
 * For the export, we always pull `period='day'` with a 365-day window so
 * the exported data is as fine-grained and complete as the schema allows
 * — the user can downsample after the fact, but cannot upsample.
 */
const EXPORT_RANGE_DAYS = 365
const EXPORT_PERIOD = 'day'

export function useStatsExportData(): UseStatsExportDataReturn {
  const [data, setData] = useState<StatsChartsBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<StatsChartsBundle> => {
    setLoading(true)
    setError(null)
    try {
      const streakYear = new Date().getFullYear()
      const [
        entries_over_time,
        writing_volume,
        mood_histogram,
        mood_trend,
        tag_frequency,
        streak_calendar,
        location_density,
      ] = await Promise.all([
        statsEntriesOverTime(EXPORT_PERIOD, EXPORT_RANGE_DAYS),
        statsWritingVolume(EXPORT_PERIOD, EXPORT_RANGE_DAYS),
        statsMoodHistogram(EXPORT_RANGE_DAYS),
        statsMoodTrend(EXPORT_RANGE_DAYS),
        statsTagFrequency(),
        statsStreakCalendar(streakYear),
        statsLocationDensity(),
      ])
      const bundle: StatsChartsBundle = {
        rangeDays: EXPORT_RANGE_DAYS,
        streakYear,
        entries_over_time,
        writing_volume,
        mood_histogram,
        mood_trend,
        tag_frequency,
        streak_calendar,
        location_density,
      }
      setData(bundle)
      return bundle
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      throw e
    } finally {
      setLoading(false)
    }
  }, [])

  return { data, loading, error, load }
}
