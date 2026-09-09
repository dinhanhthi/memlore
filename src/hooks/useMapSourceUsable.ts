import { useBasemap } from './useBasemap'
import { isMapSourceUsable, useMapSourceSettings } from './useMapSourceSettings'

/** Combined settings + basemap readiness for Locations / heatmap / previews. */
export function useMapSourceUsable(): { usable: boolean; isLoading: boolean } {
  const {
    source,
    maptilerKey,
    isLoading: settingsLoading,
    mapkitAvailable,
  } = useMapSourceSettings()
  const { status, hydrated: basemapHydrated } = useBasemap()
  // Offline tiles need on-disk status before we can tell gate vs map —
  // otherwise a ready archive flashes MapSourceGate for one frame.
  const waitingBasemap = source === 'offline' && !basemapHydrated
  const isLoading = settingsLoading || waitingBasemap
  const settingsUsable = isMapSourceUsable(source, maptilerKey, status, mapkitAvailable)
  const usable = !isLoading && settingsUsable
  return { usable, isLoading }
}
