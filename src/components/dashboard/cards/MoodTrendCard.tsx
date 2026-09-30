import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCountUp } from '../../../hooks/useCountUp'
import { useEmotionTrend } from '../../../hooks/useEmotionTrend'
import { cn } from '../../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { moodTrendBody } from '../../../lib/moodTrendBody'
import { moodSplit } from '../../../lib/vizMath'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { EmotionTrendChart } from '../../stats/EmotionTrendChart'
import { SplitBars } from '../../stats/viz/SplitBars'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'

const STORY_NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl'

export function MoodTrendCard() {
  const { t } = useTranslation('dashboard')
  const { t: tStats } = useTranslation('stats')
  const { t: tEditor } = useTranslation('editor')
  const { rows, isLoading } = useEmotionTrend('30d')
  const body = moodTrendBody(isLoading, rows)
  const split = moodSplit(
    rows.reduce(
      (acc, row) => ({
        good: acc.good + row.good,
        neutral: acc.neutral + row.neutral,
        bad: acc.bad + row.bad,
      }),
      { good: 0, neutral: 0, bad: 0 },
    ),
  )
  const goodShown = useCountUp(split.good)
  const toneText = VIZ_TONE[DASHBOARD_CARD_VISUALS.mood_trend.tone].text
  const labels = {
    good: tEditor('emotion.good'),
    neutral: tEditor('emotion.neutral'),
    bad: tEditor('emotion.bad'),
  }

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
        <div className="@container flex h-full min-h-0 flex-col gap-3">
          <div className="flex shrink-0 items-center gap-3">
            <div className="min-w-0 shrink-0">
              <div className={cn(STORY_NUMERAL, toneText)}>{goodShown}%</div>
              <p className="text-fg-muted truncate text-xs">{labels.good}</p>
            </div>
            <div className="min-w-0 flex-1">
              <SplitBars
                good={split.good}
                neutral={split.neutral}
                bad={split.bad}
                labels={labels}
                ariaLabel={t('cards.mood_trend')}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <EmotionTrendChart rows={rows} height={120} />
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
