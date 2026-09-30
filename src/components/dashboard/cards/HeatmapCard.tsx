import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCountUp } from '../../../hooks/useCountUp'
import { useStats } from '../../../hooks/useStats'
import { cn } from '../../../lib/cn'
import { localDateKey } from '../../../lib/dashboardDates'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { heatmapWindow } from '../../../lib/dashboardHeatmap'
import { statsStreakCalendar } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { getLevel } from '../../stats/StreakCalendar'
import { streakCalendarKey } from '../../stats/statsPeriod'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'

const STORY_NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl'

function heatmapCellClass(level: number): string {
  if (level === 1) return 'bg-viz-5/30'
  if (level === 2) return 'bg-viz-5/50'
  if (level === 3) return 'bg-viz-5/75'
  if (level === 4) return 'bg-viz-5'
  return 'bg-panel-2'
}

export function HeatmapCard() {
  const { t, i18n } = useTranslation('dashboard')
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
  const daysWritten = useCountUp(activeDays)
  const toneText = VIZ_TONE[DASHBOARD_CARD_VISUALS.heatmap.tone].text

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
        <div className="@container flex h-full min-h-0 flex-col gap-2">
          <div className="flex shrink-0 items-baseline gap-2">
            <span className={cn(STORY_NUMERAL, toneText)}>
              {daysWritten.toLocaleString(i18n.language)}
            </span>
            <span className="text-fg-muted truncate text-xs">{t('heatmap.hint')}</span>
          </div>
          <div
            className="grid min-h-0 flex-1 grid-flow-col grid-cols-16 grid-rows-7 gap-1"
            role="img"
            aria-label={t('heatmap.summary', { days: activeDays })}
          >
            {days.map((key) => (
              <div
                key={key}
                className={cn(
                  'h-full min-h-1 w-full rounded-sm',
                  key > today ? 'bg-transparent' : heatmapCellClass(getLevel(counts.get(key) ?? 0)),
                )}
              />
            ))}
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
