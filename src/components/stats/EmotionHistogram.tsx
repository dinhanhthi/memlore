import { useTranslation } from 'react-i18next'
import { statsMoodHistogram } from '../../lib/tauri'
import type { MoodHistogramRow } from '../../lib/tauri'
import { useStats } from '../../hooks/useStats'
import { useTheme } from '../../hooks/useTheme'
import { EMOTIONS, EMOTION_BY_KEY } from '../common/emotions'
import type { EmotionKey } from '../../types/entry'
import type { Period } from './PeriodSelector'
import { moodHistogramKey, periodRangeDays } from './statsPeriod'

interface EmotionHistogramProps {
  period: Period
}

/**
 * 3-bar emotion distribution chart. Replaces the prior `MoodTrendChart`
 * (a line chart over averaged 1-5 intensity, which no longer exists
 * after the 2026-05 refactor).
 *
 * Bars are rendered in a fixed `bad → neutral → good` order so the
 * chart reads polar even when one bucket is empty. Width is normalized
 * against the max count so the longest bar fills the row; zero-count
 * states render as a faint stripe to keep the row visible.
 */
export function EmotionHistogram({ period }: EmotionHistogramProps) {
  const { t } = useTranslation('stats')
  const { t: tEditor } = useTranslation('editor')
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const rangeDays = periodRangeDays(period)

  const cacheKey = moodHistogramKey(period)
  const { data, isLoading } = useStats<MoodHistogramRow[]>(
    () => statsMoodHistogram(rangeDays),
    cacheKey,
  )

  if (isLoading && data === null) {
    return <div className="bg-panel-2 h-32 animate-pulse rounded-lg" />
  }

  const rows = data ?? []
  const total = rows.reduce((acc, r) => acc + Number(r.count), 0)

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <p className="text-fg-muted text-sm font-medium">{t('empty.no_data')}</p>
        <p className="text-fg-muted text-xs">{t('empty.no_data_hint')}</p>
      </div>
    )
  }

  const countByKey = new Map<EmotionKey, number>()
  for (const r of rows) {
    // The DB constraint guarantees emotion ∈ { bad, neutral, good }, but
    // be defensive against any future schema drift — unknown keys are
    // silently dropped instead of crashing the chart.
    if (r.emotion === 'bad' || r.emotion === 'neutral' || r.emotion === 'good') {
      countByKey.set(r.emotion, Number(r.count))
    }
  }

  const maxCount = Math.max(...EMOTIONS.map((m) => countByKey.get(m.key) ?? 0), 1)

  return (
    <div className="flex flex-col gap-2">
      {EMOTIONS.map((meta) => {
        const count = countByKey.get(meta.key) ?? 0
        const pct = total > 0 ? Math.round((count / total) * 100) : 0
        const widthPct = (count / maxCount) * 100
        const fill = isDark ? meta.hueDark : meta.hue
        return (
          <div key={meta.key} className="flex items-center gap-3">
            <div className="flex w-24 items-center gap-2 text-sm">
              <span aria-hidden className="text-base leading-none">
                {meta.emoji}
              </span>
              <span className="font-medium">{tEditor(meta.i18nKey)}</span>
            </div>
            <div
              className="relative h-3 flex-1 overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--color-surface-subtle)' }}
            >
              <div
                className="h-full rounded-full transition-[transform] duration-300 motion-reduce:transition-none"
                style={{
                  width: `${Math.max(widthPct, count > 0 ? 4 : 0)}%`,
                  backgroundColor: fill,
                }}
              />
            </div>
            <div className="text-fg-muted w-20 text-right text-xs tabular-nums">
              {count} · {pct}%
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Re-export `EMOTION_BY_KEY` so consumers needing the meta map without
// pulling in the constants module directly have a stable path. Kept
// minimal — used by the legend in `EmotionHeatmap` and elsewhere.
export { EMOTION_BY_KEY }
