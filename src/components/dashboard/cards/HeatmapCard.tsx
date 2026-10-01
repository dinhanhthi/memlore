import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useStats } from '../../../hooks/useStats'
import { cn } from '../../../lib/cn'
import { localDateKey } from '../../../lib/dashboardDates'
import { heatmapWindow } from '../../../lib/dashboardHeatmap'
import { statsStreakCalendar } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { getLevel } from '../../stats/StreakCalendar'
import { streakCalendarKey } from '../../stats/statsPeriod'
import { DashboardCard } from '../DashboardCard'
import { DashboardNavButton } from '../DashboardNavButton'

const HEATMAP_WEEKS = 16

function heatmapCellClass(level: number): string {
  if (level === 1) return 'bg-success/25'
  if (level === 2) return 'bg-success/45'
  if (level === 3) return 'bg-success/70'
  if (level === 4) return 'bg-success'
  return 'bg-panel-2'
}

export function HeatmapCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { days } = useMemo(
    () => heatmapWindow(new Date(), HEATMAP_WEEKS, i18n.language),
    [i18n.language],
  )
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
        <DashboardNavButton
          label={t('actions.calendar')}
          onClick={() =>
            useTabStore
              .getState()
              .updateActiveTab({ activeView: 'calendar', selectedEntryId: null })
          }
        />
      }
    >
      {isLoading ? (
        <div className="bg-panel-2 h-full rounded-lg motion-safe:animate-pulse" />
      ) : error ? (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      ) : (
        <div
          className="flex h-full min-h-0 w-full items-center justify-center"
          style={{ containerType: 'size' }}
        >
          <div
            className="grid max-w-full grid-flow-col grid-rows-7 gap-1"
            style={{
              height: 'min(100cqh, calc(100cqw * 7 / 16))',
              aspectRatio: '16 / 7',
            }}
            role="img"
            aria-label={t('heatmap.summary', { days: activeDays })}
          >
            {days.map((key) => (
              <div key={key} className="flex min-h-0 min-w-0 items-center justify-center">
                <div
                  className={cn(
                    'aspect-square h-full max-w-full rounded-none',
                    key > today ? 'bg-panel-2' : heatmapCellClass(getLevel(counts.get(key) ?? 0)),
                  )}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
