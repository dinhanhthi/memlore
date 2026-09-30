import { Trans, useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { useCountUp } from '../../../hooks/useCountUp'
import { useStreaks } from '../../../hooks/useStreaks'
import { cn } from '../../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { ProgressRing } from '../../stats/viz/ProgressRing'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'

const STORY_NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl'

// ponytail: footer + this card both call recalculate_streak on mount; share via a store if it ever shows in profiles
export function StreakCard() {
  const { t } = useTranslation('dashboard')
  const { t: tNav, i18n } = useTranslation('nav')
  const { streakInfo, isLoading, error } = useStreaks()

  const current_streak = streakInfo?.current_streak ?? 0
  const longest_streak = streakInfo?.longest_streak ?? 0
  const streakCount = useCountUp(current_streak)
  const hasStreak = current_streak > 0
  const hasBest = longest_streak > 0
  const toneText = VIZ_TONE[DASHBOARD_CARD_VISUALS.streak.tone].text

  return (
    <DashboardCard
      title={t('cards.streak')}
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
      ) : hasStreak ? (
        <div className="@container flex h-full min-h-0 items-center gap-3">
          <div className="min-w-0">
            <div className={cn(STORY_NUMERAL, toneText)}>
              {streakCount.toLocaleString(i18n.language)}
            </div>
            {hasBest ? (
              <span className="text-fg-muted block truncate text-xs">
                <Trans
                  i18nKey="streak.best"
                  ns="nav"
                  values={{ count: longest_streak }}
                  components={{ b: <span className="font-semibold" /> }}
                />
              </span>
            ) : null}
          </div>
          <div className="aspect-square h-full shrink-0">
            <ProgressRing
              value={current_streak}
              goal={Math.max(current_streak, longest_streak, 1)}
              tone={3}
              ariaLabel={tNav('streak.aria_label', { count: current_streak })}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-fg text-sm font-medium">{tNav('streak.start_title')}</p>
          <p className="text-fg-muted text-xs">{tNav('streak.start_hint')}</p>
        </div>
      )}
    </DashboardCard>
  )
}
