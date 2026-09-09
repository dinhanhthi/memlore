import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import 'leaflet.heat'
import { MapPin } from 'lucide-react'
import { statsLocationDensity, type LocationPoint } from '../../lib/tauri'
import { useAccentChartColors } from '../../hooks/useAccentChartColors'
import { useMapSourceSettings } from '../../hooks/useMapSourceSettings'
import { useMapSourceUsable } from '../../hooks/useMapSourceUsable'
import { useStats } from '../../hooks/useStats'
import { useTheme } from '../../hooks/useTheme'
import { MapSourceGate } from '../map/MapSourceGate'
import { LOCATION_DENSITY_KEY } from './statsPeriod'
import { createMapBasemapLayer, DEFAULT_CENTER, DEFAULT_ZOOM } from '../map/LeafletMap'

export function LocationHeatmap() {
  const { t } = useTranslation('stats')
  const { resolvedTheme } = useTheme()
  const accent = useAccentChartColors()
  const { source, maptilerKey } = useMapSourceSettings()
  const { usable, isLoading: sourceLoading } = useMapSourceUsable()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.Layer | null>(null)
  const heatRef = useRef<L.HeatLayer | null>(null)
  const hasFittedRef = useRef(false)

  // Goes through `useStats` (not a local fetch) so `ChartsGate` can prefetch
  // the same cache key and this map mounts with its points already in hand.
  const { data: points, error } = useStats<LocationPoint[]>(
    () => statsLocationDensity(),
    LOCATION_DENSITY_KEY,
  )

  useEffect(() => {
    if (!usable || source === 'mapkit') {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        tileRef.current = null
        heatRef.current = null
        hasFittedRef.current = false
      }
      return
    }
    if (!containerRef.current || points === null || points.length === 0) return

    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        scrollWheelZoom: true,
        attributionControl: true,
      })
    }

    const map = mapRef.current

    if (tileRef.current) {
      tileRef.current.remove()
      tileRef.current = null
    }
    const layer = createMapBasemapLayer(source, resolvedTheme, maptilerKey)
    if (layer) {
      tileRef.current = layer.addTo(map)
    }

    if (heatRef.current) {
      heatRef.current.remove()
    }
    const heatData: L.HeatLatLngTuple[] = points.map((p) => [p.lat, p.lng, p.count])
    heatRef.current = L.heatLayer(heatData, {
      radius: 25,
      blur: 15,
      maxZoom: 17,
      minOpacity: 0.4,
      gradient: accent.heatGradient,
    }).addTo(map)

    if (!hasFittedRef.current) {
      if (points.length === 1) {
        map.setView([points[0].lat, points[0].lng], 10)
      } else {
        const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 })
      }
      hasFittedRef.current = true
    }
  }, [usable, points, resolvedTheme, source, maptilerKey, accent.heatGradient])

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        tileRef.current = null
        heatRef.current = null
      }
    }
  }, [])

  if (sourceLoading) {
    return <div className="bg-elevated h-80 animate-pulse rounded-lg" />
  }

  if (!usable) {
    return <MapSourceGate variant="inline" className="h-80" />
  }

  // TODO(later): heatmap overlay on MapKit source — see docs/LATER.md
  if (source === 'mapkit') {
    return (
      <div
        className="border-border-default bg-elevated flex h-80 items-center justify-center rounded-lg border px-6"
        role="status"
        data-testid="location-heatmap-mapkit-notice"
      >
        <p className="text-fg-muted max-w-md text-center text-sm leading-snug">
          {t('chart.location_heatmap.mapkit_notice')}
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-80 items-center justify-center">
        <p className="text-fg-muted text-sm">{t('empty.no_data')}</p>
      </div>
    )
  }

  if (points === null) {
    return <div className="bg-elevated h-80 animate-pulse rounded-lg" />
  }

  if (points.length === 0) {
    return (
      <div className="flex h-80 flex-col items-center justify-center gap-3">
        <MapPin className="text-fg-muted size-8" />
        <p className="text-fg-muted max-w-xs text-center text-sm">
          {t('chart.location_heatmap.empty')}
        </p>
      </div>
    )
  }

  return <div ref={containerRef} className="h-80 w-full rounded-lg" />
}
