import { Trans, useTranslation } from 'react-i18next'
import type { StreakInfo } from '../../lib/tauri'
import { Flame } from 'lucide-react'

interface StreakDisplayProps {
  streakInfo: StreakInfo | null
  compact?: boolean
}

export function StreakDisplay({ streakInfo, compact = false }: StreakDisplayProps) {
  const { t } = useTranslation('nav')
  if (!streakInfo) return null

  const { current_streak, longest_streak } = streakInfo
  const hasStreak = current_streak > 0
  const hasBest = longest_streak > 0

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-accent shrink-0">
          <Flame className="size-3.5" strokeWidth={1.75} />
        </span>
        {hasStreak ? (
          <span className="text-fg text-xs font-medium">
            {t('streak.day_count', { count: current_streak })}
          </span>
        ) : (
          <span className="text-fg-muted text-xs">{t('streak.start')}</span>
        )}
      </div>
    )
  }

  return (
    <div className="bg-elevated border-border-default rounded-2xl border p-5">
      {hasStreak ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-accent">
              <Flame className="size-5" strokeWidth={1.75} />
            </span>
            <span className="text-fg text-3xl font-bold">{current_streak}</span>
            <span className="text-fg-muted text-sm font-medium">{t('streak.day_streak')}</span>
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
          <p className="text-fg text-sm font-medium">{t('streak.start_title')}</p>
          <p className="text-fg-muted text-xs">{t('streak.start_hint')}</p>
        </div>
      )}
    </div>
  )
}
