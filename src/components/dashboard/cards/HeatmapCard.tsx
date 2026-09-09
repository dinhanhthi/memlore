import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStats } from '../../../hooks/useStats'
import { useTheme } from '../../../hooks/useTheme'
import { useThemeCustomization } from '../../../hooks/useThemeCustomization'
import { localDateKey } from '../../../lib/dashboardDates'
import { heatmapWindow } from '../../../lib/dashboardHeatmap'
import { statsStreakCalendar } from '../../../lib/tauri'
import { HEATMAP_EMPTY_CELL, STREAK_CELL_SCALE } from '../../../lib/themeColors'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { getLevel } from '../../stats/StreakCalendar'
import { streakCalendarKey } from '../../stats/statsPeriod'
import { DashboardCard } from '../DashboardCard'

export function HeatmapCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { resolvedTheme } = useTheme()
  const { surfaceStyle } = useThemeCustomization()
  const isDark = resolvedTheme === 'dark'
  const colors = isDark ? STREAK_CELL_SCALE.dark : STREAK_CELL_SCALE.light
  const emptyColor = isDark ? HEATMAP_EMPTY_CELL[surfaceStyle] : HEATMAP_EMPTY_CELL.light

  const { days } = useMemo(() => heatmapWindow(new Date(), 16, i18n.language), [i18n.language])
  const year = new Date().getFullYear()
  const current = useStats(() => statsStreakCalendar(year), streakCalendarKey(year))
  // ponytail: previous-year fetch is unconditional; gate on years.length if it shows in profiles
  const previous = useStats(() => statsStreakCalendar(year - 1), streakCalendarKey(year - 1))

  const isLoading = current.isLoading || previous.isLoading
  const error = current.error ?? previous.error

  const counts = new Map<string, number>()
  for (const row of current.data ?? []) counts.set(row.date, row.entry_count)
  for (const row of previous.data ?? []) counts.set(row.date, row.entry_count)

  const today = localDateKey(new Date())
  const activeDays = days.reduce((n, key) => n + ((counts.get(key) ?? 0) > 0 ? 1 : 0), 0)

  return (
    <DashboardCard
      title={t('cards.heatmap')}
      action={
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowRight className="size-4" />}
          onClick={() =>
            useTabStore
              .getState()
              .updateActiveTab({ activeView: 'calendar', selectedEntryId: null })
          }
        >
          {t('actions.calendar')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="bg-panel-2 h-full rounded-lg motion-safe:animate-pulse" />
      ) : error ? (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-1.5">
          <div
            className="grid h-full min-h-0 flex-1 grid-flow-col grid-cols-16 grid-rows-7 gap-1"
            role="img"
            aria-label={t('heatmap.summary', { days: activeDays })}
          >
            {days.map((key) => {
              let background = 'transparent'
              if (key <= today) {
                const level = getLevel(counts.get(key) ?? 0)
                background = level === 0 ? emptyColor : (colors[level - 1] ?? emptyColor)
              }
              return <div key={key} className="rounded-sm" style={{ background }} />
            })}
          </div>
          <p className="text-fg-muted text-xs">{t('heatmap.hint')}</p>
        </div>
      )}
    </DashboardCard>
  )
}
