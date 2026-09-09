import { useTranslation } from 'react-i18next'
import { statsWritingVolume } from '../../lib/tauri'
import type { WritingVolumePoint } from '../../lib/tauri'
import { useStats } from '../../hooks/useStats'
import type { Period } from './PeriodSelector'
import { PERIOD_CONFIG, writingVolumeKey } from './statsPeriod'

interface WordCountBoxProps {
  period: Period
}

/**
 * Single-number stat tile showing the total word count across all entries
 * in the selected period.
 *
 * Reuses the `stats_writing_volume` backend command (which aggregates words
 * per bucket) and sums the buckets client-side. Shares the `useStats` cache
 * key with `WritingVolumeChart` so the two never issue duplicate fetches —
 * whichever mounts first populates the cache for the other.
 */
export function WordCountBox({ period }: WordCountBoxProps) {
  const { t, i18n } = useTranslation('stats')
  const { range, bucket } = PERIOD_CONFIG[period]

  const cacheKey = writingVolumeKey(period)
  const { data, isLoading } = useStats<WritingVolumePoint[]>(
    () => statsWritingVolume(bucket, range),
    cacheKey,
  )

  const total = data?.reduce((sum, p) => sum + p.total_words, 0) ?? 0

  if (total === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <p className="text-fg-muted text-sm font-medium">{t('empty.no_data')}</p>
        <p className="text-fg-muted text-xs">{t('empty.no_data_hint')}</p>
      </div>
    )
  }

  if (total === 0) {
    return <div className="bg-panel-2 h-24 animate-pulse rounded-lg" />
  }

  const formatted = new Intl.NumberFormat(i18n.language).format(total)

  return (
    <div className="flex flex-col items-center justify-center gap-1 py-6">
      <span className="text-fg text-4xl font-bold tabular-nums">{formatted}</span>
      <span className="text-fg-muted text-sm">{t('chart.word_count.label')}</span>
    </div>
  )
}
