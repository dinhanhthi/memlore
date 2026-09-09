import { Earth, KeyRound, Map } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useBasemap } from '../../hooks/useBasemap'
import {
  formatBasemapSizeGb,
  useMapSourceSettings,
  type MapTileSource,
} from '../../hooks/useMapSourceSettings'
import { cn } from '../../lib/cn'
import { BASEMAP_SIZE_BYTES } from '../../lib/tauri'
import { Button } from '../common/Button'

const GATE_OPTION_IDS = [
  'offline',
  'maptiler',
  'mapkit',
] as const satisfies readonly MapTileSource[]
type GateOptionId = (typeof GATE_OPTION_IDS)[number]

interface MapSourceGateProps {
  className?: string
  /** `panel` = Locations empty-state; `inline` = heatmap / preview slot. */
  variant?: 'panel' | 'inline'
}

function openLocationSettings(updateActiveTab: ReturnType<typeof useUpdateActiveTab>) {
  updateActiveTab({
    activeView: 'settings',
    selectedEntryId: null,
    settingsCategory: 'location',
    locationTab: 'geocoding',
  })
}

/**
 * Empty-state chooser shown until a usable map source exists
 * (offline basemap ready, MapTiler key, or MapKit token). Apple Maps
 * is omitted when the compile-time token is missing.
 *
 * OSM attribution is not shown here — this panel does not render tiles.
 * Offline / MapTiler maps keep © OSM on the Leaflet control once they load.
 */
export function MapSourceGate({ className, variant = 'panel' }: MapSourceGateProps) {
  const { t } = useTranslation('settings')
  const { setSource, mapkitAvailable } = useMapSourceSettings()
  const { status, percent, size_bytes, download, cancel } = useBasemap()
  const updateActiveTab = useUpdateActiveTab()

  const sizeGb = formatBasemapSizeGb(size_bytes ?? BASEMAP_SIZE_BYTES)
  const downloading = status === 'downloading'
  const compact = variant === 'inline'

  async function chooseOffline() {
    await setSource('offline')
    if (status !== 'ready' && status !== 'downloading') {
      await download()
    }
  }

  function chooseMaptiler() {
    void setSource('maptiler')
    openLocationSettings(updateActiveTab)
  }

  function onChoose(id: GateOptionId) {
    switch (id) {
      case 'offline':
        void chooseOffline()
        return
      case 'maptiler':
        chooseMaptiler()
        return
      case 'mapkit':
        void setSource('mapkit')
        return
    }
  }

  function optionIcon(id: GateOptionId) {
    switch (id) {
      case 'offline':
        return <Earth className="size-4" strokeWidth={1.75} aria-hidden />
      case 'maptiler':
        return <KeyRound className="size-4" strokeWidth={1.75} aria-hidden />
      case 'mapkit':
        return <Map className="size-4" strokeWidth={1.75} aria-hidden />
    }
  }

  function optionAction(id: GateOptionId): string {
    if (id === 'offline') {
      if (downloading) {
        return t('location.mapSourceGate.downloading', { percent: Math.round(percent) })
      }
      if (status === 'ready') {
        return t('location.mapSourceGate.offline.use')
      }
      return t('location.mapSourceGate.offline.action')
    }
    return t(`location.mapSourceGate.${id}.action`)
  }

  return (
    <div
      data-testid="map-source-gate"
      className={cn(
        'flex items-center justify-center',
        variant === 'panel' ? 'min-h-0 flex-1 p-6' : 'h-full min-h-32',
        className,
      )}
    >
      <div
        className={cn(
          'bg-elevated border-border-default w-full rounded-2xl border',
          variant === 'panel' ? 'max-w-md p-6 shadow-(--elev-2)' : 'max-w-lg p-3',
        )}
      >
        <h2
          className={cn(
            'font-display text-fg font-extrabold',
            variant === 'panel' ? 'mb-2 text-lg' : 'mb-2 text-sm',
          )}
        >
          {t('location.mapSourceGate.title')}
        </h2>
        {!compact && (
          <p className="text-fg-muted mb-4 text-sm leading-relaxed">
            {t('location.mapSourceGate.body')}
          </p>
        )}
        <div className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-2')}>
          {GATE_OPTION_IDS.filter((id) => id !== 'mapkit' || mapkitAvailable).map((id) => {
            const isOfflineBusy = id === 'offline' && downloading
            const action = optionAction(id)
            const label =
              compact && id === 'offline'
                ? t('location.mapSourceGate.offline.label_compact', { size: sizeGb })
                : t(`location.mapSourceGate.${id}.label`)
            return (
              <div
                key={id}
                className={cn(
                  'border-border-default bg-surface-hi flex items-center rounded-xl border',
                  compact ? 'gap-2 px-2.5 py-1.5' : 'gap-3 px-4 py-3',
                )}
              >
                <div className="text-fg-muted shrink-0">{optionIcon(id)}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-fg text-sm leading-snug font-medium">{label}</p>
                  {!compact && (
                    <p className="text-fg-muted text-xs leading-snug">
                      {id === 'offline'
                        ? t('location.mapSourceGate.offline.description', { size: sizeGb })
                        : t(`location.mapSourceGate.${id}.description`)}
                    </p>
                  )}
                </div>
                {isOfflineBusy ? (
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => void cancel()}
                    className="shrink-0"
                    aria-label={`${label} — ${t('basemap.status.cancel')}`}
                  >
                    {t('basemap.status.cancel')}
                  </Button>
                ) : (
                  <Button
                    variant={id === 'offline' && status !== 'ready' ? 'primary' : 'secondary'}
                    size={compact ? 'xs' : 'sm'}
                    onClick={() => onChoose(id)}
                    className="shrink-0"
                    aria-label={`${label} — ${action}`}
                  >
                    {action}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
