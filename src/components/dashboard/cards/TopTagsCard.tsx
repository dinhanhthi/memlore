import { useTranslation } from 'react-i18next'
import { useStats } from '../../../hooks/useStats'
import { cn } from '../../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { statsTagFrequency } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { TAG_FREQUENCY_KEY } from '../../stats/statsPeriod'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'
import { DashboardNavButton } from '../DashboardNavButton'

const STORY_NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl'

const BAR_LIMIT = 3

function barWidth(count: number, top: number): string {
  if (top <= 0) return '0%'
  return `${Math.min(100, Math.round((count / top) * 100))}%`
}

export function TopTagsCard() {
  const { t } = useTranslation('dashboard')
  const { data, isLoading, error } = useStats(statsTagFrequency, TAG_FREQUENCY_KEY)
  const tags = (data ?? []).slice(0, BAR_LIMIT)
  const top = tags[0]
  const topCount = top?.count ?? 0
  const toneText = VIZ_TONE[DASHBOARD_CARD_VISUALS.top_tags.tone].text

  const openTag = (tagId: string | null) => {
    useTabStore.getState().updateActiveTab({
      activeView: 'tags',
      selectedTagId: tagId,
      selectedEntryId: null,
    })
  }

  return (
    <DashboardCard
      title={t('cards.top_tags')}
      action={<DashboardNavButton label={t('actions.tags')} onClick={() => openTag(null)} />}
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
      ) : top == null ? (
        <p className="text-fg-muted text-sm">{t('top_tags.empty')}</p>
      ) : (
        <div className="@container flex h-full min-h-0 items-center gap-3">
          <button
            type="button"
            className={cn(STORY_NUMERAL, toneText, 'min-w-0 flex-1 truncate text-left')}
            onClick={() => openTag(top.tag_id)}
          >
            {top.tag_name}
          </button>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-1">
            {tags.map((row) => (
              <button
                key={row.tag_id}
                type="button"
                className="flex min-w-0 items-center gap-1.5 text-left"
                onClick={() => openTag(row.tag_id)}
              >
                <span className="text-fg-secondary w-24 shrink-0 truncate text-xs">
                  #{row.tag_name}
                </span>
                <span className="bg-panel-2 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                  <span
                    className="bg-viz-2 block h-full rounded-full"
                    style={{ width: barWidth(row.count, topCount) }}
                  />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
