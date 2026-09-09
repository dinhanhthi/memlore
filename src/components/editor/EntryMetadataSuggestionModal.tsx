import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { formatEntryDateWithYear } from '../../lib/dates'
import { geocodeReverse } from '../../lib/tauri'
import type { ExifLocation } from '../../lib/tauri'
import { cn } from '../../lib/cn'

/**
 * Unified suggestion modal for EXIF metadata found in attached media.
 *
 * Replaces the previous separate EntryDateSuggestionModal and
 * EntryLocationSuggestionModal. Shows whichever kind(s) are non-empty:
 *
 *   - Both present → two-tab UI (Date | Location), tab strip visible.
 *   - One present  → single content, tab strip HIDDEN entirely.
 *   - Neither      → the caller does not render this modal.
 *
 * Single "Use these values" button applies whichever side(s) the user
 * picked. A "Keep current" option per tab lets the user keep either
 * field untouched while still applying the other.
 *
 * Location labels are reverse-geocoded in parallel on mount (using the
 * project's configured geocoding provider) and fall back to raw lat,lng
 * strings if the provider returns no match or the network call fails.
 */
export interface EntryMetadataSuggestionPayload {
  /** May be undefined when no EXIF date suggestion exists. */
  date?: number
  /** May be undefined when no EXIF location suggestion exists. */
  location?: ExifLocation
  /** Reverse-geocoded human-readable name for the picked location, e.g.
   *  "Eiffel Tower". Null if the provider returned no match or the API
   *  call failed — caller should fall back to the raw lat/lng string
   *  when displaying. */
  locationLabel?: string | null
  /** Reverse-geocoded full address for the picked location, e.g.
   *  "Eiffel Tower, Champ de Mars, Paris, France". Same fallback rules
   *  as `locationLabel`. */
  locationAddress?: string | null
}

interface EntryMetadataSuggestionModalProps {
  dates: number[]
  locations: ExifLocation[]
  onConfirm: (payload: EntryMetadataSuggestionPayload) => void | Promise<void>
  /** Called when the user dismisses (Cancel / outside click / Esc).
   *  Triggers the "user has finalized" durable suppression for whichever
   *  side(s) the caller passes — same semantics as the old modals. */
  onClose: () => void
}

const KEEP_CURRENT = '__keep__' as const
type TabKey = 'date' | 'location'

function rawCoordLabel(loc: ExifLocation): string {
  return `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`
}

export function EntryMetadataSuggestionModal({
  dates,
  locations,
  onConfirm,
  onClose,
}: EntryMetadataSuggestionModalProps) {
  const { t } = useTranslation('editor')
  const hasDates = dates.length > 0
  const hasLocations = locations.length > 0
  const showTabs = hasDates && hasLocations
  const [activeTab, setActiveTab] = useState<TabKey>(hasDates ? 'date' : 'location')

  // Per-tab selection state. `KEEP_CURRENT` means "don't apply this side".
  const [selectedDate, setSelectedDate] = useState<number | typeof KEEP_CURRENT>(
    hasDates ? dates[0] : KEEP_CURRENT,
  )
  const [selectedLocationIndex, setSelectedLocationIndex] = useState<number | typeof KEEP_CURRENT>(
    hasLocations ? 0 : KEEP_CURRENT,
  )

  // Reverse-geocoded results per location, keyed by index. Stores both
  // the short label and the full address so the parent can persist both
  // to the entry when the user confirms.
  interface ReverseGeocodeResult {
    label: string | null
    address: string | null
  }
  const [locationLabels, setLocationLabels] = useState<Record<number, ReverseGeocodeResult>>({})

  useEffect(() => {
    if (!hasLocations) return
    let cancelled = false
    void Promise.all(
      locations.map(async (loc, i): Promise<[number, ReverseGeocodeResult | null]> => {
        try {
          const result = await geocodeReverse(loc.latitude, loc.longitude)
          if (!result) return [i, null]
          return [
            i,
            {
              label: result.label || null,
              address: result.address || null,
            },
          ]
        } catch {
          return [i, null]
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      const map: Record<number, ReverseGeocodeResult> = {}
      for (const [i, result] of entries) {
        if (result) map[i] = result
      }
      setLocationLabels(map)
    })
    return () => {
      cancelled = true
    }
    // Re-run only when the location set itself changes — labels are
    // tied to (latitude, longitude) pairs.
  }, [locations, hasLocations])

  function handleConfirm() {
    const payload: EntryMetadataSuggestionPayload = {}
    if (hasDates && selectedDate !== KEEP_CURRENT) {
      payload.date = selectedDate
    }
    if (hasLocations && selectedLocationIndex !== KEEP_CURRENT) {
      payload.location = locations[selectedLocationIndex]
      const reverse = locationLabels[selectedLocationIndex]
      payload.locationLabel = reverse?.label ?? null
      payload.locationAddress = reverse?.address ?? null
    }
    void onConfirm(payload)
    onClose()
  }

  const tabClass = (key: TabKey) =>
    cn(
      'cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
      activeTab === key
        ? 'bg-surface-hi text-fg border-border-default shadow-(--elev-1)'
        : 'text-fg-muted hover:text-fg border-transparent',
    )

  const headerLabel = useMemo(() => {
    if (showTabs) return t('metadata_suggestion.header_both')
    if (hasDates) return t('metadata_suggestion.header_dates')
    return t('metadata_suggestion.header_locations')
  }, [showTabs, hasDates, t])

  return (
    <Modal onClose={onClose}>
      <Modal.Header>{headerLabel}</Modal.Header>
      <Modal.Body>
        {showTabs && (
          <div className="mb-4 inline-flex w-fit gap-1 rounded-xl">
            <button type="button" onClick={() => setActiveTab('date')} className={tabClass('date')}>
              {t('metadata_suggestion.tab_date')}
              {dates.length > 1 ? ` (${dates.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('location')}
              className={tabClass('location')}
            >
              {t('metadata_suggestion.tab_location')}
              {locations.length > 1 ? ` (${locations.length})` : ''}
            </button>
          </div>
        )}

        {activeTab === 'date' && hasDates && (
          <>
            <p className="text-fg-muted mb-3 text-sm">{t('metadata_suggestion.choose_date')}</p>
            <div role="radiogroup" className="flex flex-col gap-2">
              {dates.map((ts) => (
                <label
                  key={ts}
                  className="text-fg flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                  style={{
                    background: selectedDate === ts ? 'var(--grad-accent-soft)' : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    name="exif-date"
                    value={String(ts)}
                    checked={selectedDate === ts}
                    onChange={() => setSelectedDate(ts)}
                    className="accent-accent"
                  />
                  {formatEntryDateWithYear(ts)}
                </label>
              ))}
              <label
                className="text-fg-muted flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                style={{
                  background:
                    selectedDate === KEEP_CURRENT ? 'var(--grad-accent-soft)' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="exif-date"
                  value={KEEP_CURRENT}
                  checked={selectedDate === KEEP_CURRENT}
                  onChange={() => setSelectedDate(KEEP_CURRENT)}
                  className="accent-accent"
                />
                {t('metadata_suggestion.keep_date')}
              </label>
            </div>
          </>
        )}

        {activeTab === 'location' && hasLocations && (
          <>
            <p className="text-fg-muted mb-3 text-sm">{t('metadata_suggestion.choose_location')}</p>
            <div role="radiogroup" className="flex flex-col gap-2">
              {locations.map((loc, i) => {
                const reverse = locationLabels[i]
                const primary = reverse?.label ?? reverse?.address ?? null
                return (
                  <label
                    key={`${loc.latitude}-${loc.longitude}`}
                    className="text-fg flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                    style={{
                      background:
                        selectedLocationIndex === i ? 'var(--grad-accent-soft)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="exif-location"
                      value={String(i)}
                      checked={selectedLocationIndex === i}
                      onChange={() => setSelectedLocationIndex(i)}
                      className="accent-accent mt-0.5"
                    />
                    <span className="flex flex-col leading-tight">
                      <span className="text-fg">{primary ?? rawCoordLabel(loc)}</span>
                      {primary && (
                        <span className="text-fg-muted text-2xs">{rawCoordLabel(loc)}</span>
                      )}
                    </span>
                  </label>
                )
              })}
              <label
                className="text-fg-muted flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                style={{
                  background:
                    selectedLocationIndex === KEEP_CURRENT
                      ? 'var(--grad-accent-soft)'
                      : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name="exif-location"
                  value={KEEP_CURRENT}
                  checked={selectedLocationIndex === KEEP_CURRENT}
                  onChange={() => setSelectedLocationIndex(KEEP_CURRENT)}
                  className="accent-accent"
                />
                {t('metadata_suggestion.keep_location')}
              </label>
            </div>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('metadata_suggestion.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleConfirm}>
          {t('metadata_suggestion.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
