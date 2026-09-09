import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { EmotionTrendChartRow } from '../../hooks/useEmotionTrend'
import { useTheme } from '../../hooks/useTheme'
import { CHART_NEUTRAL } from '../../lib/themeColors'
import { EMOTIONS } from '../common/emotions'

interface EmotionTrendChartProps {
  rows: EmotionTrendChartRow[]
  height?: number
}

export function EmotionTrendChart({ rows, height = 240 }: EmotionTrendChartProps) {
  const { t: tEditor } = useTranslation('editor')
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const colors = CHART_NEUTRAL

  const emotionColors = useMemo(
    () =>
      Object.fromEntries(EMOTIONS.map((m) => [m.key, isDark ? m.hueDark : m.hue])) as Record<
        'bad' | 'neutral' | 'good',
        string
      >,
    [isDark],
  )

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
        <XAxis
          dataKey="periodStart"
          tick={{ fontSize: 11, fill: colors.text }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: colors.text }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: colors.cursor_fill, fillOpacity: colors.cursor_opacity }}
          contentStyle={{
            backgroundColor: colors.tooltip_bg,
            border: `1px solid ${colors.tooltip_border}`,
            borderRadius: '8px',
            fontSize: 12,
          }}
        />
        <Legend
          formatter={(value) => tEditor(`emotion.${value}`)}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Bar dataKey="bad" stackId="emo" fill={emotionColors.bad} name="bad" />
        <Bar dataKey="neutral" stackId="emo" fill={emotionColors.neutral} name="neutral" />
        <Bar dataKey="good" stackId="emo" fill={emotionColors.good} name="good" />
      </BarChart>
    </ResponsiveContainer>
  )
}
