import { useTranslation } from 'react-i18next'
import { statsStreakCalendar } from '../../lib/tauri'
import type { StreakCalendarDay } from '../../lib/tauri'
import { HEATMAP_EMPTY_CELL, STREAK_CELL_SCALE } from '../../lib/themeColors'
import { useStats } from '../../hooks/useStats'
import { useTheme } from '../../hooks/useTheme'
import { useThemeCustomization } from '../../hooks/useThemeCustomization'
import { streakCalendarKey } from './statsPeriod'

// Color intensity buckets: 0, 1-2, 3-5, 6-9, 10+
export function getLevel(count: number): number {
  if (count === 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 9) return 3
  return 4
}

const CELL_SIZE = 10
const CELL_GAP = 2
const CELL_STEP = CELL_SIZE + CELL_GAP

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function buildCalendarGrid(
  year: number,
  data: StreakCalendarDay[],
): { date: string; count: number; weekCol: number; dayRow: number }[] {
  const countByDate = new Map<string, number>()
  for (const d of data) {
    countByDate.set(d.date, d.entry_count)
  }

  // Jan 1 of the year
  const jan1 = new Date(year, 0, 1)
  // Day of week for Jan 1 (0=Sun, 1=Mon … 6=Sat)
  const startDow = jan1.getDay()

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const totalDays = isLeap ? 366 : 365

  const cells = []
  for (let i = 0; i < totalDays; i++) {
    const cellIndex = startDow + i
    const weekCol = Math.floor(cellIndex / 7)
    const dayRow = cellIndex % 7
    const d = new Date(year, 0, 1 + i)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const dateStr = `${d.getFullYear()}-${mm}-${dd}`
    cells.push({
      date: dateStr,
      count: countByDate.get(dateStr) ?? 0,
      weekCol,
      dayRow,
    })
  }

  return cells
}

function buildMonthLabels(year: number): { month: string; weekCol: number }[] {
  const labels: { month: string; weekCol: number }[] = []
  const jan1Dow = new Date(year, 0, 1).getDay()

  for (let m = 0; m < 12; m++) {
    const firstOfMonth = new Date(year, m, 1)
    const dayOfYear = Math.floor(
      (firstOfMonth.getTime() - new Date(year, 0, 1).getTime()) / (1000 * 60 * 60 * 24),
    )
    const weekCol = Math.floor((jan1Dow + dayOfYear) / 7)
    labels.push({ month: MONTH_NAMES[m] ?? '', weekCol })
  }
  return labels
}

const MONTH_LABEL_HEIGHT = 16
const SVG_PADDING_LEFT = 0
const TOTAL_COLS = 53

export function StreakCalendar() {
  const { t } = useTranslation('stats')
  const { resolvedTheme } = useTheme()
  const { surfaceStyle } = useThemeCustomization()
  const year = new Date().getFullYear()
  const cacheKey = streakCalendarKey(year)

  const { data, isLoading } = useStats<StreakCalendarDay[]>(
    () => statsStreakCalendar(year),
    cacheKey,
  )

  const isDark = resolvedTheme === 'dark'
  const colors = isDark ? STREAK_CELL_SCALE.dark : STREAK_CELL_SCALE.light
  const emptyColor = isDark ? HEATMAP_EMPTY_CELL[surfaceStyle] : HEATMAP_EMPTY_CELL.light
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
    return <div className="bg-panel-2 h-24 animate-pulse rounded-lg" />
  }

  const cells = buildCalendarGrid(year, data)
  const monthLabels = buildMonthLabels(year)

  const svgWidth = SVG_PADDING_LEFT + TOTAL_COLS * CELL_STEP
  const svgHeight = MONTH_LABEL_HEIGHT + 7 * CELL_STEP

  return (
    <div className="overflow-x-auto">
      <p className="text-fg-muted mb-2 text-xs">
        {t('chart.streak_calendar.year_label', { year })}
      </p>
      <svg
        width={svgWidth}
        height={svgHeight}
        aria-label={t('chart.streak_calendar.title')}
        role="img"
      >
        {/* Month labels */}
        {monthLabels.map(({ month, weekCol }) => (
          <text
            key={month}
            x={SVG_PADDING_LEFT + weekCol * CELL_STEP}
            y={MONTH_LABEL_HEIGHT - 4}
            fontSize={10}
            fill="var(--color-fg-muted)"
          >
            {month}
          </text>
        ))}

        {/* Day cells */}
        {cells.map(({ date, count, weekCol, dayRow }) => {
          const level = getLevel(count)
          const fill = level === 0 ? emptyColor : (colors[level - 1] ?? emptyColor)
          const x = SVG_PADDING_LEFT + weekCol * CELL_STEP
          const y = MONTH_LABEL_HEIGHT + dayRow * CELL_STEP
          return (
            <rect
              key={date}
              data-testid="day-cell"
              x={x}
              y={y}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={2}
              fill={fill}
            >
              <title>{`${date}: ${count}`}</title>
            </rect>
          )
        })}
      </svg>
    </div>
  )
}
