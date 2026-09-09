import { useTranslation } from 'react-i18next'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { statsEntriesOverTime } from '../../lib/tauri'
import type { EntriesOverTimePoint } from '../../lib/tauri'
import { useAccentChartColors } from '../../hooks/useAccentChartColors'
import { useStats } from '../../hooks/useStats'
import { CHART_NEUTRAL } from '../../lib/themeColors'
import type { Period } from './PeriodSelector'
import { PERIOD_CONFIG, entriesOverTimeKey } from './statsPeriod'

interface EntriesOverTimeChartProps {
  period: Period
}

export function EntriesOverTimeChart({ period }: EntriesOverTimeChartProps) {
  const { t } = useTranslation('stats')
  const { range, bucket } = PERIOD_CONFIG[period]

  const cacheKey = entriesOverTimeKey(period)
  const { data, isLoading } = useStats<EntriesOverTimePoint[]>(
    () => statsEntriesOverTime(bucket, range),
    cacheKey,
  )

  const colors = CHART_NEUTRAL
  const accent = useAccentChartColors()
  const hasData = data !== null && data.length > 0

  if (!hasData && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <p className="text-fg-muted text-sm font-medium">{t('empty.no_data')}</p>
        <p className="text-fg-muted text-xs">{t('empty.no_data_hint')}</p>
      </div>
    )
  }

  if (!hasData) {
    return <div className="bg-panel-2 h-48 animate-pulse rounded-lg" />
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
        <XAxis
          dataKey="period_start"
          tick={{ fontSize: 11, fill: colors.text }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis tick={{ fontSize: 11, fill: colors.text }} tickLine={false} axisLine={false} />
        <Tooltip
          formatter={(value) => [
            typeof value === 'number' ? value : 0,
            t('chart.entries_over_time.tooltip'),
          ]}
          contentStyle={{
            backgroundColor: colors.tooltip_bg,
            border: `1px solid ${colors.tooltip_border}`,
            borderRadius: '8px',
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="count"
          stroke={accent.primary}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: accent.primary }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
