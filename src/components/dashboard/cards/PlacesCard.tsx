import { MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCountUp } from '../../../hooks/useCountUp'
import { useStats } from '../../../hooks/useStats'
import { cn } from '../../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../../lib/dashboardCardVisuals'
import { statsLocationDensity } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { LOCATION_DENSITY_KEY } from '../../stats/statsPeriod'
import { VIZ_TONE } from '../../stats/viz/vizTone'
import { DashboardCard } from '../DashboardCard'
import { DashboardNavButton } from '../DashboardNavButton'

const STORY_NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl'

export function PlacesCard() {
  const { t, i18n } = useTranslation('dashboard')
  const { data, isLoading, error } = useStats(statsLocationDensity, LOCATION_DENSITY_KEY)
  const points = data ?? []
  const places = points.length
  const entries = points.reduce((s, p) => s + p.count, 0)
  const placeCount = useCountUp(places)
  const toneText = VIZ_TONE[DASHBOARD_CARD_VISUALS.places.tone].text

  return (
    <DashboardCard
      title={t('cards.places')}
      action={
        <DashboardNavButton
          label={t('actions.map')}
          onClick={() =>
            useTabStore.getState().updateActiveTab({ activeView: 'map', selectedEntryId: null })
          }
        />
      }
    >
      {isLoading ? (
        <div className="bg-panel-2 h-full rounded-lg motion-safe:animate-pulse" />
      ) : error ? (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      ) : places === 0 ? (
        <p className="text-fg-muted text-sm">{t('places.empty')}</p>
      ) : (
        <div className="@container flex h-full min-h-0 flex-col justify-center gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <MapPin className={cn('size-5 shrink-0', toneText)} />
            <span className={cn(STORY_NUMERAL, toneText, 'min-w-0 truncate')}>
              {placeCount.toLocaleString(i18n.language)}
            </span>
          </div>
          <p className="text-fg-muted truncate text-xs">
            {t('places.summary', { count: places, entries })}
          </p>
        </div>
      )}
    </DashboardCard>
  )
}
