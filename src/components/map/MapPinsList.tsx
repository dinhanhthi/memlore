import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, MapPin as MapPinIcon } from 'lucide-react'
import { Button } from '../common/Button'
import { formatEntryDateWithYear } from '../../lib/dates'
import { groupPinsByPlace } from '../../lib/mapPlaces'
import type { MapPin } from '../../types/map'

interface MapPinsListProps {
  pins: MapPin[]
  onOpenEntry: (entryId: string) => void
}

function formatCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`
}

/**
 * Web places list: places → entries, no network. Shown until the user turns
 * on MapTiler tiles (`MapTilesConsent`). Clicking an entry opens it in the
 * map view's editor overlay.
 */
export function MapPinsList({ pins, onOpenEntry }: MapPinsListProps) {
  const { t, i18n } = useTranslation('nav')
  const places = useMemo(() => groupPinsByPlace(pins), [pins])

  return (
    <section
      data-testid="map-pins-list"
      aria-labelledby="map-pins-list-title"
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <h2 id="map-pins-list-title" className="text-fg-secondary mb-2 text-sm font-semibold">
        {t('locations_view.places_title')}
      </h2>
      {places.length === 0 ? (
        <p className="text-fg-muted text-sm">{t('locations_view.places_empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {places.map((place) => (
            <li key={place.key} className="bg-panel-2 border-border-subtle rounded-xl border p-3">
              <div className="mb-1 flex items-start gap-2">
                <MapPinIcon className="text-fg-muted mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-fg truncate text-sm font-medium">
                    {place.label ?? t('locations_view.unnamed_place')}
                  </p>
                  {place.label === null && (
                    <p className="text-fg-muted text-xs">
                      {formatCoords(place.latitude, place.longitude)}
                    </p>
                  )}
                </div>
                <span className="text-fg-muted shrink-0 text-xs">
                  {t('locations_view.entry_count', { count: place.entries.length })}
                </span>
              </div>
              <ul className="flex flex-col">
                {place.entries.map((entry) => {
                  const date = formatEntryDateWithYear(entry.entryDate, i18n.language)
                  return (
                    <li key={entry.entryId}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenEntry(entry.entryId)}
                        aria-label={t('locations_view.open_entry_aria', { date })}
                        className="w-full justify-between"
                      >
                        <span className="truncate">{date}</span>
                        <ChevronRight className="size-4 shrink-0" aria-hidden />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
