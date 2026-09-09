import { useTranslation } from 'react-i18next'
import { statsTagFrequency } from '../../lib/tauri'
import type { TagFrequencyRow } from '../../lib/tauri'
import { useAccentChartColors } from '../../hooks/useAccentChartColors'
import { useStats } from '../../hooks/useStats'
import { TAG_FREQUENCY_KEY } from './statsPeriod'

const MAX_TAGS = 20

export function TagCloud() {
  const { t } = useTranslation('stats')
  const accent = useAccentChartColors()

  const { data, isLoading } = useStats<TagFrequencyRow[]>(
    () => statsTagFrequency(),
    TAG_FREQUENCY_KEY,
  )

  const hasData = data !== null && data.length > 0

  if (!hasData && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <p className="text-fg-muted text-sm font-medium">{t('chart.tag_frequency.no_tags')}</p>
      </div>
    )
  }

  if (!hasData) {
    return <div className="bg-panel-2 h-48 animate-pulse rounded-lg" />
  }

  const topTags = data.slice(0, MAX_TAGS)
  const maxCount = topTags[0]?.count ?? 1

  return (
    <ul role="list" className="flex flex-col gap-2">
      {topTags.map((row) => {
        const barPercent = Math.round((row.count / maxCount) * 100)
        return (
          <li key={row.tag_id} role="listitem" className="flex items-center gap-2">
            <span className="text-fg-secondary w-24 shrink-0 truncate text-sm">{row.tag_name}</span>
            <div className="bg-panel-2 h-2 flex-1 rounded-full">
              <div
                className="h-full rounded-full"
                style={{ width: `${barPercent}%`, backgroundColor: accent.primary }}
              />
            </div>
            <span className="text-fg-muted w-8 shrink-0 text-right text-xs">{row.count}</span>
          </li>
        )
      })}
    </ul>
  )
}
