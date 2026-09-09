import { ArrowRight, MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useStats } from '../../../hooks/useStats'
import { statsLocationDensity } from '../../../lib/tauri'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { LOCATION_DENSITY_KEY } from '../../stats/statsPeriod'
import { DashboardCard } from '../DashboardCard'

export function PlacesCard() {
  const { t } = useTranslation('dashboard')
  const { data, isLoading, error } = useStats(statsLocationDensity, LOCATION_DENSITY_KEY)
  const points = data ?? []
  const places = points.length
  const entries = points.reduce((s, p) => s + p.count, 0)

  return (
    <DashboardCard
      title={t('cards.places')}
      action={
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowRight className="size-4" />}
          onClick={() =>
            useTabStore.getState().updateActiveTab({ activeView: 'map', selectedEntryId: null })
          }
        >
          {t('actions.map')}
        </Button>
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
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <MapPin className="text-accent size-5" />
            <span className="text-fg text-3xl font-bold tabular-nums">{places}</span>
          </div>
          <p className="text-fg-muted text-xs">{t('places.summary', { count: places, entries })}</p>
        </div>
      )}
    </DashboardCard>
  )
}
