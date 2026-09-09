import { Trans, useTranslation } from 'react-i18next'
import { ArrowRight, Flame } from 'lucide-react'
import { useStreaks } from '../../../hooks/useStreaks'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { DashboardCard } from '../DashboardCard'

// ponytail: footer + this card both call recalculate_streak on mount; share via a store if it ever shows in profiles
export function StreakCard() {
  const { t } = useTranslation('dashboard')
  const { t: tNav } = useTranslation('nav')
  const { streakInfo, isLoading, error } = useStreaks()

  const current_streak = streakInfo?.current_streak ?? 0
  const longest_streak = streakInfo?.longest_streak ?? 0
  const hasStreak = current_streak > 0
  const hasBest = longest_streak > 0

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
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-accent">
              <Flame className="size-5" strokeWidth={1.75} />
            </span>
            <span className="text-fg text-3xl font-bold">{current_streak}</span>
            <span className="text-fg-muted text-sm font-medium">{tNav('streak.day_streak')}</span>
          </div>
          {hasBest && (
            <p className="text-fg-muted text-xs">
              <Trans
                i18nKey="streak.best"
                ns="nav"
                values={{ count: longest_streak }}
                components={{ b: <span className="font-semibold" /> }}
              />
            </p>
          )}
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
