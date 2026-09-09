/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { leafletLayer } from 'protomaps-leaflet'
import { cn } from '../../lib/cn'
import { useTheme } from '../../hooks/useTheme'
import { useMapSourceSettings, type MapTileSource } from '../../hooks/useMapSourceSettings'
import { useMapSourceUsable } from '../../hooks/useMapSourceUsable'
import { getBasemapPmtiles } from '../../lib/pmtilesSource'
import { useMarkerCluster } from './MarkerClusterGroup'
import type { MapPin } from '../../types/map'

// Note: we no longer wire Leaflet's bundled marker PNGs — every pin uses a
// custom `L.divIcon` (see `markerIcons.ts`). The PNG default icons rendered
// as broken images in the Tauri webview, which is why this view switched
// to div-icons in the first place.

export const ATTRIBUTION_OFFLINE = '© OpenStreetMap contributors · Protomaps'
export const ATTRIBUTION_MAPTILER = '© MapTiler © OpenStreetMap contributors'
export const DEFAULT_CENTER: [number, number] = [20, 0]
export const DEFAULT_ZOOM = 2

/** World extract is `world-z8.pmtiles` (z0–8). Higher display zooms overzoom. */
const OFFLINE_MAX_DATA_ZOOM = 8

/** Leaflet's own default raster max. `L.map()` MUST carry it explicitly:
 *  `getMaxZoom()` falls back to the attached layers, and neither the
 *  protomaps vector layer (no `maxZoom` option) nor the layer-less window
 *  before the source resolves supplies one — `leaflet.markercluster` throws
 *  "Map has no maxZoom specified" on `onAdd` when it reads `Infinity`. */
const MAP_MAX_ZOOM = 18

function maptilerTileUrl(resolvedTheme: 'light' | 'dark', key: string): string {
  const darkSuffix = resolvedTheme === 'dark' ? '-dark' : ''
  return `https://api.maptiler.com/maps/streets-v2${darkSuffix}/{z}/{x}/{y}.png?key=${key}`
}

type LeafletLayerOptions = NonNullable<Parameters<typeof leafletLayer>[0]>
type LeafletPmtilesUrl = NonNullable<LeafletLayerOptions['url']>

/**
 * Basemap layer for the chosen source. `leafletLayer` accepts
 * `url: PMTiles | string`, so the local `Source` is wrapped in `PMTiles`.
 * protomaps-leaflet types against pmtiles@3; we ship pmtiles@4 — same
 * `Source` protocol at runtime (`getKey` / `getBytes`).
 *
 * TODO(later): custom OKLCH-branded protomaps flavor — see docs/LATER.md.
 */
export function createMapBasemapLayer(
  source: MapTileSource | null,
  resolvedTheme: 'light' | 'dark',
  maptilerKey: string,
): L.Layer | null {
  if (source === 'offline') {
    return leafletLayer({
      url: getBasemapPmtiles() as unknown as LeafletPmtilesUrl,
      flavor: resolvedTheme === 'dark' ? 'dark' : 'light',
      maxDataZoom: OFFLINE_MAX_DATA_ZOOM,
      attribution: ATTRIBUTION_OFFLINE,
    }) as unknown as L.Layer
  }
  if (source === 'maptiler' && maptilerKey.trim().length > 0) {
    return L.tileLayer(maptilerTileUrl(resolvedTheme, maptilerKey), {
      attribution: ATTRIBUTION_MAPTILER,
      referrerPolicy: 'no-referrer',
    })
  }
  return null
}

export interface LeafletMapProps {
  pins: MapPin[]
  onPinClick: (pin: MapPin) => void
  initialCenter?: [number, number]
  initialZoom?: number
  /**
   * Height is REQUIRED for Leaflet to render. If the caller does not supply
   * a height via `className`, the wrapper falls back to `min-h-75` so a
   * forgotten sizing class doesn't silently render a 0px map.
   */
  className?: string
}

function LeafletMapCanvas({
  pins,
  onPinClick,
  initialCenter,
  initialZoom,
  className,
}: Required<Pick<LeafletMapProps, 'pins' | 'onPinClick' | 'initialCenter' | 'initialZoom'>> &
  Pick<LeafletMapProps, 'className'>) {
  const { t } = useTranslation('common')
  const { resolvedTheme } = useTheme()
  const { source, maptilerKey } = useMapSourceSettings()
  const { usable } = useMapSourceUsable()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.Layer | null>(null)
  const [map, setMap] = useState<L.Map | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current, {
        center: initialCenter,
        zoom: initialZoom,
        maxZoom: MAP_MAX_ZOOM,
        scrollWheelZoom: true,
        attributionControl: true,
      })
      setMap(mapRef.current)
    }

    const mapInstance = mapRef.current
    if (tileRef.current) {
      tileRef.current.remove()
      tileRef.current = null
    }
    // Recreate the layer on theme / source swap so the tile cache flushes;
    // otherwise already-loaded tiles of the old palette linger on a static
    // viewport until the user pans.
    if (!usable) return
    const layer = createMapBasemapLayer(source, resolvedTheme, maptilerKey)
    if (!layer) return
    tileRef.current = layer.addTo(mapInstance)
  }, [resolvedTheme, source, maptilerKey, usable, initialCenter, initialZoom])

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        tileRef.current = null
      }
      setMap(null)
    }
  }, [])

  // After the map-lifecycle effect so cluster cleanup runs before map.remove().
  useMarkerCluster(map, pins, onPinClick)

  return <div ref={containerRef} className={className} aria-label={t('map.aria_label')} />
}

export function LeafletMap({
  pins,
  onPinClick,
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
  className,
}: LeafletMapProps) {
  const { t } = useTranslation('common')
  const fallbackSizing = className ? '' : 'min-h-75 w-full'

  if (pins.length === 0) {
    return (
      <div
        className={cn(fallbackSizing, 'flex items-center justify-center p-8', className)}
        role="status"
        aria-label={t('map.aria_label')}
        data-testid="leaflet-map-empty"
      >
        <p className="text-fg-muted text-sm">{t('map.empty')}</p>
      </div>
    )
  }

  return (
    <LeafletMapCanvas
      pins={pins}
      onPinClick={onPinClick}
      initialCenter={initialCenter}
      initialZoom={initialZoom}
      className={cn(fallbackSizing, className)}
    />
  )
}
