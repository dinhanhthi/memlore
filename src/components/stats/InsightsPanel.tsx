import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEmotionTrend } from '../../hooks/useEmotionTrend'
import { PeriodSelector, type Period } from './PeriodSelector'
import { EmotionTrendChart } from './EmotionTrendChart'
import { ThemeInsightsSection } from './ThemeInsightsSection'

function periodToRange(period: Period): { start: number; end: number } {
  const rangeDays =
    period === '7d'
      ? 7
      : period === '30d'
        ? 30
        : period === '90d'
          ? 90
          : period === '365d'
            ? 365
            : 3650
  const end = Math.floor(Date.now() / 1000)
  const start = end - rangeDays * 86_400
  return { start, end }
}

/**
 * Insights dashboard — emotion trend chart (local data) plus on-demand
 * AI theme / mood-driver analysis for the selected period.
 */
export function InsightsPanel() {
  const { t } = useTranslation('stats')
  const [period, setPeriod] = useState<Period>('30d')

  const { rows, isLoading: trendLoading } = useEmotionTrend(period)
  const range = useMemo(() => periodToRange(period), [period])
  const trendTotal = rows.reduce((acc, r) => acc + r.total, 0)

  return (
    <div className="space-y-8 py-2">
      <div>
        <h2 className="font-display text-fg text-lg font-semibold">
          {t('insights.title', { defaultValue: 'Insights' })}
        </h2>
        <p className="text-fg-muted mt-1 text-sm leading-relaxed">
          {t('insights.description', {
            defaultValue:
              'See how your logged emotions trend over time, then ask AI to surface recurring themes and mood drivers for the period.',
          })}
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-fg text-sm font-semibold">
            {t('insights.emotion_trend_title', { defaultValue: 'Emotion trend' })}
          </h3>
          <PeriodSelector value={period} onChange={setPeriod} />
        </div>

        {trendLoading && rows.length === 0 ? (
          <div className="bg-panel-2 h-48 animate-pulse rounded-lg" />
        ) : trendTotal === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <p className="text-fg-muted text-sm font-medium">{t('empty.no_data')}</p>
            <p className="text-fg-muted text-xs">{t('insights.emotion_trend_empty_hint')}</p>
          </div>
        ) : (
          <EmotionTrendChart rows={rows} />
        )}
      </section>

      <ThemeInsightsSection start={range.start} end={range.end} />
    </div>
  )
}
