import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStats } from '../../../hooks/useStats'
import { statsTagFrequency } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { TAG_FREQUENCY_KEY } from '../../stats/statsPeriod'
import { DashboardCard } from '../DashboardCard'

export function TopTagsCard() {
  const { t } = useTranslation('dashboard')
  const { data, isLoading, error } = useStats(statsTagFrequency, TAG_FREQUENCY_KEY)
  const tags = (data ?? []).slice(0, 6)

  return (
    <DashboardCard
      title={t('cards.top_tags')}
      action={
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowRight className="size-4" />}
          onClick={() =>
            useTabStore.getState().updateActiveTab({
              activeView: 'tags',
              selectedTagId: null,
              selectedEntryId: null,
            })
          }
        >
          {t('actions.tags')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex max-h-14 flex-wrap gap-1.5 overflow-hidden">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="bg-panel-2 h-5 w-16 rounded-full motion-safe:animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-danger-text text-sm" role="alert">
          {error}
        </p>
      ) : tags.length === 0 ? (
        <p className="text-fg-muted text-sm">{t('top_tags.empty')}</p>
      ) : (
        <div className="flex max-h-14 flex-wrap gap-1.5 overflow-hidden">
          {tags.map((row) => (
            <button
              key={row.tag_id}
              type="button"
              className="bg-panel-2 text-fg-secondary hover:text-fg rounded-full px-2.5 py-0.5 text-xs"
              onClick={() =>
                useTabStore.getState().updateActiveTab({
                  activeView: 'tags',
                  selectedTagId: row.tag_id,
                  selectedEntryId: null,
                })
              }
            >
              #{row.tag_name} <span className="text-fg-muted">{row.count}</span>
            </button>
          ))}
        </div>
      )}
    </DashboardCard>
  )
}
