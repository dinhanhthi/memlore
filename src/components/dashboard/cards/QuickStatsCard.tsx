import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStats } from '../../../hooks/useStats'
import { statsEntriesOverTime, statsWritingVolume } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { entriesOverTimeKey, writingVolumeKey } from '../../stats/statsPeriod'
import { DashboardCard } from '../DashboardCard'

export function QuickStatsCard() {
  const { t } = useTranslation('dashboard')
  const entries7d = useStats(() => statsEntriesOverTime('day', 7), entriesOverTimeKey('7d'))
  const entries30d = useStats(() => statsEntriesOverTime('day', 30), entriesOverTimeKey('30d'))
  const volume7d = useStats(() => statsWritingVolume('day', 7), writingVolumeKey('7d'))

  const isLoading = entries7d.isLoading || entries30d.isLoading || volume7d.isLoading
  const stats = [
    {
      value: entries7d.data?.reduce((sum, row) => sum + row.count, 0) ?? 0,
      error: entries7d.error,
      label: t('quick_stats.entries_7d'),
    },
    {
      value: entries30d.data?.reduce((sum, row) => sum + row.count, 0) ?? 0,
      error: entries30d.error,
      label: t('quick_stats.entries_30d'),
    },
    {
      value: volume7d.data?.reduce((sum, row) => sum + row.total_words, 0) ?? 0,
      error: volume7d.error,
      label: t('quick_stats.words_7d'),
    },
  ]

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
      <div className="grid grid-cols-3 gap-3">
        {isLoading
          ? [0, 1, 2].map((key) => (
              <div key={key} className="flex min-w-0 flex-col gap-1.5">
                <div className="bg-panel-2 h-8 w-12 rounded-md motion-safe:animate-pulse" />
                <div className="bg-panel-2 h-3 w-full rounded-md motion-safe:animate-pulse" />
              </div>
            ))
          : stats.map((stat) => (
              <div key={stat.label} className="min-w-0">
                {stat.error ? (
                  <p className="text-danger-text text-sm" role="alert">
                    {stat.error}
                  </p>
                ) : (
                  <div className="text-fg text-2xl font-semibold tabular-nums">{stat.value}</div>
                )}
                <div className="text-fg-muted text-xs leading-snug">{stat.label}</div>
              </div>
            ))}
      </div>
    </DashboardCard>
  )
}
