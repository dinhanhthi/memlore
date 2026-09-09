import { useTranslation } from 'react-i18next'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { statsWritingVolume } from '../../lib/tauri'
import type { WritingVolumePoint } from '../../lib/tauri'
import { useAccentChartColors } from '../../hooks/useAccentChartColors'
import { useStats } from '../../hooks/useStats'
import { CHART_NEUTRAL } from '../../lib/themeColors'
import type { Period } from './PeriodSelector'
import { PERIOD_CONFIG, writingVolumeKey } from './statsPeriod'

interface WritingVolumeChartProps {
  period: Period
}

export function WritingVolumeChart({ period }: WritingVolumeChartProps) {
  const { t } = useTranslation('stats')
  const { range, bucket } = PERIOD_CONFIG[period]

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const cacheKey = writingVolumeKey(period)
  const { data, isLoading } = useStats<WritingVolumePoint[]>(
    () => statsWritingVolume(bucket, range),
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
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
        <XAxis
          dataKey="period_start"
          tick={{ fontSize: 11, fill: colors.text }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: colors.text }}
          tickLine={false}
          axisLine={false}
          label={{
            value: t('chart.writing_volume.axis_y'),
            angle: -90,
            position: 'insideLeft',
            style: { fontSize: 10, fill: colors.text },
          }}
        />
        <Tooltip
          cursor={{ fill: colors.cursor_fill, fillOpacity: colors.cursor_opacity }}
          formatter={(value) => [
            typeof value === 'number' ? value : 0,
            t('chart.writing_volume.tooltip'),
          ]}
          contentStyle={{
            backgroundColor: colors.tooltip_bg,
            border: `1px solid ${colors.tooltip_border}`,
            borderRadius: '8px',
            fontSize: 12,
          }}
        />
        <Bar
          dataKey="total_words"
          fill={accent.primary}
          radius={[4, 4, 0, 0]}
          isAnimationActive={!prefersReducedMotion}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
