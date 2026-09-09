import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, X } from 'lucide-react'
import { useMapPins } from '../../hooks/useMapPins'
import { useSelectedEntryId, useUpdateActiveTab } from '../../hooks/useActiveTab'
import { LeafletMap } from './LeafletMap'
import { MapKitMap } from './MapKitMap'
import LocationsMapSkeleton from './LocationsMapSkeleton'
import { EditorPanel } from '../layout/EditorPanel'
import { Tooltip } from '../common/Tooltip'
import { SyncCatchupBanner } from '../common/SyncCatchupBanner'
import { cn } from '../../lib/cn'
import type { MapPin } from '../../types/map'
import { useUiStore } from '../../stores/uiStore'
import { useMapSourceSettings } from '../../hooks/useMapSourceSettings'
import { useMapSourceUsable } from '../../hooks/useMapSourceUsable'
import { MapSourceGate } from './MapSourceGate'
// Match the editor's primary reading column so content reflow stays
// consistent between the in-overlay editor and the main editor view.
// Width is clamped to the viewport so it never overflows on narrow windows.
const OVERLAY_WIDTH_CLASS = 'w-[min(720px,90vw)]'

/**
 * Locations Map — full-width map with an EditorPanel that slides in from the
 * right edge when a pin is clicked.
 *
 * Selection is held in the active tab's `selectedEntryId` (not local state)
 * so FooterBar (word count / save status) and TitleBar (entry title) stay
 * in sync while the overlay is open. The overlay opens automatically when
 * `selectedEntryId` is non-null and the user is on the map view; closing it
 * clears the tab's selection.
 *
 * Until a usable map source exists (offline basemap ready, a MapTiler
 * key, or a compile-time MapKit token), `MapSourceGate` replaces the map.
 * After the gate, tiles come from the local PMTiles archive, MapTiler, or
 * Apple MapKit JS — never OSM / Carto hosts.
 */
export function LocationsMapView() {
  const designSystem = useUiStore((s) => s.designSystem)
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'
  const { t } = useTranslation('palette')
  const { t: tNav } = useTranslation('nav')
  const { usable, isLoading: sourceLoading } = useMapSourceUsable()
  const { source } = useMapSourceSettings()
  const selectedEntryId = useSelectedEntryId()
  const updateActiveTab = useUpdateActiveTab()
  const { pins, isLoading, error, isEmpty } = useMapPins()

  const overlayOpen = selectedEntryId !== null

  const closeOverlay = () => {
    updateActiveTab({ selectedEntryId: null })
  }

  const openLocationSettings = () => {
    updateActiveTab({
      activeView: 'settings',
      selectedEntryId: null,
      settingsCategory: 'location',
    })
  }

  // Close the overlay on Escape — but only if no higher-priority modal
  // (Modal, MediaGalleryCarousel, SearchOverlay) is open. Those mark themselves
  // with `aria-modal="true"`; if any are present, they handle Esc and the
  // map overlay stays open.
  useEffect(() => {
    if (!overlayOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[aria-modal="true"]')) return
      closeOverlay()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // closeOverlay is stable in spirit (depends only on updateActiveTab,
    // which is a Zustand action) — re-listing every render would needlessly
    // re-bind the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayOpen])

  const handlePinClick = (pin: MapPin) => {
    updateActiveTab({ selectedEntryId: pin.entryId })
  }

  const showCount = !isLoading && !error && !isEmpty
  const countLabel = tNav('locations_view.pin_count', { count: pins.length })

  return (
    <div
      data-testid="locations-map-view"
      className={cn(
        'relative isolate flex h-full flex-col overflow-hidden p-4',
        isClay && 'xj-main-panel bg-selected-tab rounded-2xl shadow-(--shadow-panel)',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="font-title text-fg text-2xl font-extrabold">
          {tNav('locations_view.title')}
          {showCount ? ` · ${countLabel}` : ''}
        </h1>
        <Tooltip content={t('settings.location', { defaultValue: 'Settings → Location' })}>
          <button
            type="button"
            onClick={openLocationSettings}
            aria-label={t('settings.location', { defaultValue: 'Settings → Location' })}
            data-testid="locations-settings-button"
            className="text-fg-muted hover:bg-elevated hover:text-fg inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors motion-reduce:transition-none"
          >
            <Settings className="size-4" />
          </button>
        </Tooltip>
      </div>

      {sourceLoading ? (
        <LocationsMapSkeleton />
      ) : !usable ? (
        <MapSourceGate />
      ) : (
        <>
          {error && (
            <p className="text-danger-text mb-3 text-sm" role="alert">
              {error}
            </p>
          )}

          {isLoading && !error && <LocationsMapSkeleton />}

          {!isLoading && !error && (
            <div
              className={cn(
                'badge-border flex-1 rounded-2xl p-0.5 shadow-xl',
                isClean && 'shadow-none',
              )}
            >
              <div className="h-full w-full overflow-hidden rounded-2xl">
                {source === 'mapkit' ? (
                  <MapKitMap pins={pins} onPinClick={handlePinClick} className="h-full w-full" />
                ) : (
                  <LeafletMap pins={pins} onPinClick={handlePinClick} className="h-full w-full" />
                )}
              </div>
            </div>
          )}
        </>
      )}

      <footer className="shrink-0 pt-3 empty:hidden">
        <SyncCatchupBanner className="border-none p-0" />
      </footer>

      {/* Click-through backdrop — only intercepts clicks while the overlay
          is open, so the map stays fully interactive otherwise. Clicking
          the empty area outside the overlay slides it back out. */}
      {overlayOpen && (
        <div
          data-testid="map-editor-backdrop"
          onClick={closeOverlay}
          className="absolute inset-0 z-1100 cursor-pointer"
          aria-hidden="true"
        />
      )}

      {/* Sliding editor overlay — sits inside the map view so it covers
          the map (not the sidebar). `translate-x-full` parks it off-screen
          to the right; toggling to `translate-x-0` slides it in.
          `motion-reduce:transition-none` honors prefers-reduced-motion.
          `inert` when closed removes the entire subtree from the tab order
          and the a11y tree (no focus traps to descendants while hidden). */}
      <div
        data-testid="map-editor-overlay"
        data-open={overlayOpen}
        inert={!overlayOpen}
        className={cn(
          'border-border-default absolute inset-y-0 right-0 z-1200 flex transform-gpu flex-col border-l shadow-2xl transition-transform duration-300 ease-out motion-reduce:transition-none',
          OVERLAY_WIDTH_CLASS,
          'bg-panel-3',
          overlayOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
      >
        <div className="border-border-default flex items-center justify-end border-b px-2 py-1.5">
          {/* Icon-only close — mirrors MediaGalleryCarousel's raw <button> pattern;
              <Button> uses inline style for height/padding so it cannot be
              squared off for an icon-only affordance. */}
          <Tooltip content={tNav('locations_view.close_tooltip')}>
            <button
              type="button"
              onClick={closeOverlay}
              aria-label={tNav('locations_view.close_aria')}
              className="text-fg-muted hover:bg-elevated hover:text-fg inline-flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors motion-reduce:transition-none"
            >
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <EditorPanel entryId={selectedEntryId} />
        </div>
      </div>
    </div>
  )
}
