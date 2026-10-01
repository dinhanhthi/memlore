import { useTranslation } from 'react-i18next'
import { useCountUp } from '../../../hooks/useCountUp'
import { useStreaks } from '../../../hooks/useStreaks'
import { cn } from '../../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'

const STORY_NUMERAL =
  'font-title text-3xl leading-none font-semibold tabular-nums @min-[8rem]:text-4xl'

// ponytail: footer + this card both call recalculate_streak on mount; share via a store if it ever shows in profiles
export function StreakCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { streakInfo, isLoading, error } = useStreaks()

  const currentStreak = streakInfo?.current_streak ?? 0
  const streakCount = useCountUp(currentStreak)
  const toneText = VIZ_TONE[DASHBOARD_CARD_VISUALS.streak.tone].text

  return (
    <DashboardCard title={t('cards.streak')}>
      {isLoading ? (
        <div className="bg-panel-2 h-full rounded-lg motion-safe:animate-pulse" />
      ) : error ? (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      ) : (
        <div className="flex h-full items-center">
          <span className={cn(STORY_NUMERAL, toneText)}>
            {streakCount.toLocaleString(i18n.language)}
          </span>
        </div>
      )}
    </DashboardCard>
  )
}
