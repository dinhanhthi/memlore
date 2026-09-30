import {
  statsEntriesOverTime,
  statsMoodHistogram,
  statsStreakCalendar,
  statsWritingHours,
  statsWritingVolume,
  type MoodHistogramRow,
  type StreakCalendarDay,
  type WritingHourRow,
} from '../lib/tauri'
import { moodSplit, peakHour } from '../lib/vizMath'
import type { Period } from '../components/stats/PeriodSelector'
import {
  PERIOD_CONFIG,
  entriesOverTimeKey,
  moodHistogramKey,
  periodRangeDays,
  streakCalendarKey,
  writingHoursKey,
  writingVolumeKey,
} from '../components/stats/statsPeriod'
import { useStats } from './useStats'
import { useStreaks } from './useStreaks'

export interface StoryNumbers {
  entries: { total: number; series: number[] }
  words: { total: number; series: number[] }
  streak: { current: number; longest: number }
  mood: { good: number; neutral: number; bad: number }
  hours: { rows: WritingHourRow[]; peak: number | null }
  heatmap: { days: StreakCalendarDay[] }
  isLoading: boolean
  /** Streak info has not arrived yet. The hero stays up; only the streak numeral waits. */
  streakPending: boolean
  error: string | null
}

/**
 * Story-in-numbers aggregate. Cache keys match the ones `ChartsGate` and the
 * charts already use, so a warm Statistics cache is a hit rather than a
 * second fetch. Each source is read on its own: one failure leaves the
 * others' totals and series in place.
 */
export function useStoryNumbers(period: Period, year: number): StoryNumbers {
  const { range, bucket } = PERIOD_CONFIG[period]
  const rangeDays = periodRangeDays(period)

  const entries = useStats(() => statsEntriesOverTime(bucket, range), entriesOverTimeKey(period))
  const words = useStats(() => statsWritingVolume(bucket, range), writingVolumeKey(period))
  const mood = useStats(() => statsMoodHistogram(rangeDays), moodHistogramKey(period))
  const hours = useStats(() => statsWritingHours(rangeDays), writingHoursKey(period))
  const heatmap = useStats(() => statsStreakCalendar(year), streakCalendarKey(year))
  const streaks = useStreaks()

  const entrySeries = (entries.data ?? []).map((point) => point.count)
  const wordSeries = (words.data ?? []).map((point) => point.total_words)
  const hourRows = hours.data ?? []

  return {
    entries: { total: sum(entrySeries), series: entrySeries },
    words: { total: sum(wordSeries), series: wordSeries },
    streak: {
      current: streaks.streakInfo?.current_streak ?? 0,
      longest: streaks.streakInfo?.longest_streak ?? 0,
    },
    mood: moodSplit(countMoods(mood.data)),
    hours: { rows: hourRows, peak: peakHour(hourRows) },
    heatmap: { days: heatmap.data ?? [] },
    // `useStreaks` is not warmed by ChartsGate. Including it here blanks the
    // six tiles after entries, words, mood, hours, and the heatmap have
    // already resolved.
    isLoading: [
      entries.isLoading,
      words.isLoading,
      mood.isLoading,
      hours.isLoading,
      heatmap.isLoading,
    ].some(Boolean),
    streakPending: streaks.streakInfo === null && streaks.isLoading,
    error:
      entries.error ?? words.error ?? mood.error ?? hours.error ?? streaks.error ?? heatmap.error,
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function countMoods(rows: MoodHistogramRow[] | null): {
  good: number
  neutral: number
  bad: number
} {
  const counts = { good: 0, neutral: 0, bad: 0 }
  if (rows === null) return counts
  for (const row of rows) {
    if (row.emotion === 'good' || row.emotion === 'neutral' || row.emotion === 'bad') {
      counts[row.emotion] += row.count
    }
  }
  return counts
}
