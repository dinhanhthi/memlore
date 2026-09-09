import React, { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiUsageDailyPoint } from '../../types/ai'
import { AiUsageSectionHeading } from './AiUsageSectionHeading'

interface Props {
  data: AiUsageDailyPoint[]
}

// ─── Lazy recharts ───────────────────────────────────────────────────────────
// Recharts is ~90KB gzip. Lazy-import it so it stays out of the initial
// AI settings bundle and is only loaded when the Usage tab is first opened.

const LazyBarChart = React.lazy(async () => {
  const { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } =
    await import('recharts')

  function Chart({ data: chartData }: Props) {
    const { t } = useTranslation('ai')

    if (chartData.length === 0) {
      return (
        <div className="text-fg-muted flex h-32 items-center justify-center text-sm">
          {t('usage.no_data_chart')}
        </div>
      )
    }

    return (
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border-subtle" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(v: string) => v.slice(5)} // Show MM-DD only
            className="text-fg-muted"
          />
          <YAxis
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => (v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : String(v))}
            className="text-fg-muted"
            width={40}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-fg)', fillOpacity: 0.06 }}
            contentStyle={{
              background: 'var(--color-elevated)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: '6px',
              fontSize: '12px',
            }}
            labelClassName="text-fg-secondary"
            itemStyle={{ color: 'var(--color-text-primary)' }}
          />
          <Bar dataKey="tokens_out" fill="var(--color-accent)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return { default: Chart }
})

// ─── Public component ────────────────────────────────────────────────────────

export function AiUsageDailyChart({ data }: Props) {
  const { t } = useTranslation('ai')

  return (
    <div className="space-y-2">
      <AiUsageSectionHeading
        title={t('usage.daily_chart_title')}
        help={t('usage.daily_chart_help')}
      />
      <Suspense
        fallback={
          <div
            className="bg-elevated h-32 animate-pulse rounded"
            aria-label={t('usage.chart_loading')}
          />
        }
      >
        <LazyBarChart data={data} />
      </Suspense>
    </div>
  )
}
