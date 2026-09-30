import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCountUp } from '../../../hooks/useCountUp'
import { useStats } from '../../../hooks/useStats'
import { cn } from '../../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { statsEntriesOverTime, statsWritingVolume } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { entriesOverTimeKey, writingVolumeKey } from '../../stats/statsPeriod'
import { MiniBars } from '../../stats/viz/MiniBars'
import { Sparkline } from '../../stats/viz/Sparkline'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'

const STORY_NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl'

export function QuickStatsCard() {
  const { t, i18n } = useTranslation('dashboard')
  // 7-day entries stay fetched so the shared stats cache matches the charts tab.
  const entries7d = useStats(() => statsEntriesOverTime('day', 7), entriesOverTimeKey('7d'))
  const entries30d = useStats(() => statsEntriesOverTime('day', 30), entriesOverTimeKey('30d'))
  const volume7d = useStats(() => statsWritingVolume('day', 7), writingVolumeKey('7d'))

  const entriesTotal = entries30d.data?.reduce((sum, row) => sum + row.count, 0) ?? 0
  const wordsTotal = volume7d.data?.reduce((sum, row) => sum + row.total_words, 0) ?? 0
  const entriesCount = useCountUp(entriesTotal)
  const wordsCount = useCountUp(wordsTotal)
  const entrySeries = (entries30d.data ?? []).map((row) => row.count)
  const wordSeries = (volume7d.data ?? []).map((row) => row.total_words)

  const isLoading = entries7d.isLoading || entries30d.isLoading || volume7d.isLoading
  const entriesLabel = t('quick_stats.entries_30d')
  const wordsLabel = t('quick_stats.words_7d')

  return (
    <DashboardCard
      title={t('cards.quick_stats')}
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
      {isLoading ? (
        <div className="grid h-full grid-cols-2 gap-3">
          {[0, 1].map((key) => (
            <div key={key} className="flex min-w-0 items-center gap-2">
              <div className="bg-panel-2 h-8 w-12 rounded-md motion-safe:animate-pulse" />
              <div className="bg-panel-2 h-full min-h-8 flex-1 rounded-md motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      ) : (
        <div className="@container grid h-full min-h-0 grid-cols-2 gap-3">
          <div className="flex min-h-0 min-w-0 items-center gap-2">
            <div className="min-w-0">
              {entries30d.error ? (
                <p className="text-danger-text text-sm" role="alert">
                  {entries30d.error}
                </p>
              ) : (
                <div
                  className={cn(
                    STORY_NUMERAL,
                    VIZ_TONE[DASHBOARD_CARD_VISUALS.quick_stats.tone].text,
                  )}
                >
                  {entriesCount.toLocaleString(i18n.language)}
                </div>
              )}
              <div className="text-fg-muted truncate text-xs">{entriesLabel}</div>
            </div>
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <Sparkline values={entrySeries} tone={1} ariaLabel={entriesLabel} />
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 items-center gap-2">
            <div className="min-w-0">
              {volume7d.error ? (
                <p className="text-danger-text text-sm" role="alert">
                  {volume7d.error}
                </p>
              ) : (
                <div className={cn(STORY_NUMERAL, VIZ_TONE[2].text)}>
                  {wordsCount.toLocaleString(i18n.language)}
                </div>
              )}
              <div className="text-fg-muted truncate text-xs">{wordsLabel}</div>
            </div>
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              <MiniBars values={wordSeries} tone={2} ariaLabel={wordsLabel} />
            </div>
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
