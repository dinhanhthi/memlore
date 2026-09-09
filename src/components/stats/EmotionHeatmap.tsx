import { useTranslation } from 'react-i18next'
import { useEntryEmotionByDate } from '../../hooks/useEntryEmotionByDate'
import { useTheme } from '../../hooks/useTheme'
import { useThemeCustomization } from '../../hooks/useThemeCustomization'
import { HEATMAP_EMPTY_CELL } from '../../lib/themeColors'
import { EMOTIONS, EMOTION_BY_KEY } from '../common/emotions'
import type { EmotionKey } from '../../types/entry'

// Geometry mirrors `StreakCalendar` so the two heatmaps line up
// visually when stacked.
const CELL_SIZE = 10
const CELL_GAP = 2
const CELL_STEP = CELL_SIZE + CELL_GAP
const MONTH_LABEL_HEIGHT = 16
const SVG_PADDING_LEFT = 0
const TOTAL_COLS = 53

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

interface Cell {
  date: string
  emotion: EmotionKey | null
  weekCol: number
  dayRow: number
}

function buildCalendarGrid(year: number, byDate: Map<string, EmotionKey[]>): Cell[] {
  const jan1 = new Date(year, 0, 1)
  const startDow = jan1.getDay()
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const totalDays = isLeap ? 366 : 365

  const cells: Cell[] = []
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
      // Year-heatmap cells are single-colour; pick the latest emotion
      // (array[0]) when a day has more than one logged.
      emotion: byDate.get(dateStr)?.[0] ?? null,
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

interface EmotionHeatmapProps {
  /** Year to render. Parent owns this so the Stats page can sync the
   * EmotionHeatmap and the existing StreakCalendar to the same year. */
  year?: number
}

/**
 * Year-long emotion heatmap (GitHub-contributions style, 3 colors for
 * the 3 emotion states). Parallel to `StreakCalendar` — same geometry,
 * different signal: writing frequency vs. how the user felt.
 *
 * Empty cells (days without a tagged emotion) render as the subtle
 * border color so the grid keeps its shape regardless of how many
 * days the user actually tagged.
 */
export function EmotionHeatmap({ year = new Date().getFullYear() }: EmotionHeatmapProps) {
  const { t } = useTranslation('stats')
  const { t: tEditor } = useTranslation('editor')
  const { resolvedTheme } = useTheme()
  const { surfaceStyle } = useThemeCustomization()
  const isDark = resolvedTheme === 'dark'

  const { data: byDate, isLoading, error } = useEntryEmotionByDate(year)

  const emptyColor = isDark ? HEATMAP_EMPTY_CELL[surfaceStyle] : HEATMAP_EMPTY_CELL.light
  const cells = buildCalendarGrid(year, byDate)
  const monthLabels = buildMonthLabels(year)
  const svgWidth = SVG_PADDING_LEFT + TOTAL_COLS * CELL_STEP
  const svgHeight = MONTH_LABEL_HEIGHT + 7 * CELL_STEP

  if (isLoading && byDate.size === 0) {
    return <div className="bg-fg/10 h-39 rounded-lg motion-safe:animate-pulse" />
  }

  if (error) {
    return (
      <div role="alert" className="text-danger-text text-sm">
        {error}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="mb-2 flex items-baseline gap-2">
        <p className="text-fg-muted text-xs">{t('chart.emotion_heatmap.year_label', { year })}</p>
      </div>
      <svg
        width={svgWidth}
        height={svgHeight}
        aria-label={t('chart.emotion_heatmap.title')}
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

        {/* Day cells — fill = emotion hue (or empty bg). */}
        {cells.map(({ date, emotion, weekCol, dayRow }) => {
          const meta = emotion ? EMOTION_BY_KEY[emotion] : null
          const fill = meta ? (isDark ? meta.hueDark : meta.hue) : emptyColor
          const x = SVG_PADDING_LEFT + weekCol * CELL_STEP
          const y = MONTH_LABEL_HEIGHT + dayRow * CELL_STEP
          const label = meta ? `${date} — ${tEditor(meta.i18nKey)}` : date
          return (
            <rect
              key={date}
              data-testid="emotion-day-cell"
              x={x}
              y={y}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={2}
              fill={fill}
            >
              <title>{label}</title>
            </rect>
          )
        })}
      </svg>

      {/* Legend */}
      <div className="text-fg-muted text-2xs mt-2 flex items-center gap-3">
        {EMOTIONS.map((meta) => (
          <span key={meta.key} className="flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: isDark ? meta.hueDark : meta.hue }}
            />
            <span>{tEditor(meta.i18nKey)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
