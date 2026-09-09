import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEmotionTrend } from '../../../hooks/useEmotionTrend'
import { moodTrendBody } from '../../../lib/moodTrendBody'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { EmotionTrendChart } from '../../stats/EmotionTrendChart'
import { DashboardCard } from '../DashboardCard'

export function MoodTrendCard() {
  const { t } = useTranslation('dashboard')
  const { t: tStats } = useTranslation('stats')
  const { rows, isLoading } = useEmotionTrend('30d')
  const body = moodTrendBody(isLoading, rows)

  return (
    <DashboardCard
      title={t('cards.mood_trend')}
      action={
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowRight className="size-4" />}
          onClick={() =>
            useTabStore
              .getState()
              .updateActiveTab({ activeView: 'stats', statsTab: 'charts', selectedEntryId: null })
          }
        >
          {t('actions.stats')}
        </Button>
      }
    >
      {body === 'skeleton' ? (
        <div className="bg-panel-2 h-full rounded-lg motion-safe:animate-pulse" />
      ) : body === 'empty' ? (
        <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
          <p className="text-fg-muted text-sm font-medium">{tStats('empty.no_data')}</p>
          <p className="text-fg-muted text-xs">{tStats('insights.emotion_trend_empty_hint')}</p>
        </div>
      ) : (
        <EmotionTrendChart rows={rows} height={190} />
      )}
    </DashboardCard>
  )
}
