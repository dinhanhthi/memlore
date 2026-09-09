import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  statsEntriesOverTime,
  statsLocationDensity,
  statsMoodHistogram,
  statsStreakCalendar,
  statsTagFrequency,
  statsWritingVolume,
} from '../../lib/tauri'
import { hasCachedStats, invalidateStatsCache, useStats } from '../../hooks/useStats'
import { hasCachedEntryEmotion, useEntryEmotionByDate } from '../../hooks/useEntryEmotionByDate'
import { Button } from '../common/Button'
import ChartsSkeleton from './ChartsSkeleton'
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

interface ChartsGateProps {
  period: Period
  children: ReactNode
}

/**
 * Shows the skeleton while it warms the chart caches. Unmounted by
 * `ChartsGate` the moment every command has settled, so it never re-fetches on
 * a later period switch — the charts own that transition once they are up.
 */
function ChartsPrefetch({ period, onReady }: { period: Period; onReady: () => void }) {
  const { t } = useTranslation('stats')
  const { range, bucket } = PERIOD_CONFIG[period]
  const year = new Date().getFullYear()

  const entries = useStats(() => statsEntriesOverTime(bucket, range), entriesOverTimeKey(period))
  const volume = useStats(() => statsWritingVolume(bucket, range), writingVolumeKey(period))
  const mood = useStats(() => statsMoodHistogram(periodRangeDays(period)), moodHistogramKey(period))
  const tags = useStats(() => statsTagFrequency(), TAG_FREQUENCY_KEY)
  const streak = useStats(() => statsStreakCalendar(year), streakCalendarKey(year))
  const locations = useStats(() => statsLocationDensity(), LOCATION_DENSITY_KEY)
  const emotion = useEntryEmotionByDate(year)

  const results = [entries, volume, mood, tags, streak, locations, emotion]
  const settled = results.every((r) => !r.isLoading)
  const failed = results.some((r) => r.error)

  useEffect(() => {
    if (settled && !failed) onReady()
  }, [settled, failed, onReady])

  // Pull the lazy chart chunks in parallel with the data instead of after it,
  // so opening the gate does not hand straight over to the Suspense fallback.
  useEffect(() => {
    void Promise.all([
      import('./EntriesOverTimeChart'),
      import('./WritingVolumeChart'),
      import('./WordCountBox'),
      import('./EmotionHistogram'),
      import('./TagCloud'),
      import('./StreakCalendar'),
      import('./EmotionHeatmap'),
      import('./LocationHeatmap'),
    ]).catch(() => {
      // Chunk errors surface through the charts' own Suspense boundary.
    })
  }, [])

  if (settled && failed) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <p role="alert" className="text-danger-text text-sm">
          {t('empty.load_failed')}
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={() => invalidateStatsCache()}>
          {t('empty.retry')}
        </Button>
      </div>
    )
  }

  return <ChartsSkeleton />
}

/**
 * Holds the Charts tab on a single `ChartsSkeleton` until the chart data has
 * landed, then mounts the charts.
 *
 * Without it the tab loads in two visually different stages: the Suspense
 * fallback while the lazy chart chunks download, then the real cards with a
 * grey placeholder inside each one while the commands are still in flight.
 *
 * `ChartsPrefetch` fetches through `useStats` / `useEntryEmotionByDate` with
 * the *same* cache keys the charts use, so by the time the gate opens the
 * module cache is warm and every chart reads it synchronously — no second
 * placeholder, no duplicate fetch. The prefetcher then unmounts, so a later
 * period switch costs exactly the fetches the charts themselves issue.
 *
 * A warm success cache opens the gate before the first paint
 * (`hasCachedStats` + `hasCachedEntryEmotion`). Cached errors keep the gate
 * closed and show a retry affordance instead of re-opening the two-stage load.
 */
export function ChartsGate({ period, children }: ChartsGateProps) {
  const year = new Date().getFullYear()
  const [ready, setReady] = useState(
    () => chartsCacheKeys(period, year).every(hasCachedStats) && hasCachedEntryEmotion(year),
  )

  if (!ready) return <ChartsPrefetch period={period} onReady={() => setReady(true)} />
  return <>{children}</>
}
