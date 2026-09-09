import { useEffect, useRef } from 'react'
import { MapPin } from 'lucide-react'
import L from 'leaflet'
import { useTheme } from '../../hooks/useTheme'
import { useMapSourceSettings } from '../../hooks/useMapSourceSettings'
import { useMapSourceUsable } from '../../hooks/useMapSourceUsable'
import { cn } from '../../lib/cn'
import { createMapBasemapLayer } from './LeafletMap'
import { MapKitPreview } from './MapKitPreview'
import { MapSourceGate } from './MapSourceGate'

const PREVIEW_ZOOM = 14

interface LocationMapPreviewProps {
  latitude: number
  longitude: number
  /** Shown on the map container for screen readers. */
  ariaLabel: string
  /** Announced when the preview recenters (e.g. after picking a new address). */
  liveDescription: string
  className?: string
}

function LocationMapPreviewCanvas({
  latitude,
  longitude,
  ariaLabel,
}: {
  latitude: number
  longitude: number
  ariaLabel: string
}) {
  const { resolvedTheme } = useTheme()
  const { source, maptilerKey } = useMapSourceSettings()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.Layer | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current, {
        center: [latitude, longitude],
        zoom: PREVIEW_ZOOM,
        scrollWheelZoom: false,
        dragging: false,
        doubleClickZoom: false,
        zoomControl: false,
        attributionControl: true,
      })
    }

    const map = mapRef.current
    map.setView([latitude, longitude], PREVIEW_ZOOM, { animate: false })

    if (tileRef.current) {
      tileRef.current.remove()
      tileRef.current = null
    }
    const layer = createMapBasemapLayer(source, resolvedTheme, maptilerKey)
    if (layer) {
      tileRef.current = layer.addTo(map)
    }

    if (markerRef.current) {
      markerRef.current.remove()
    }
    markerRef.current = L.circleMarker([latitude, longitude], {
      radius: 8,
      color: 'var(--color-accent)',
      fillColor: 'var(--color-accent)',
      fillOpacity: 0.85,
      weight: 2,
    }).addTo(map)
  }, [latitude, longitude, resolvedTheme, source, maptilerKey])

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        tileRef.current = null
        markerRef.current = null
      }
    }
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-32 w-full rounded-xl outline-none [--map-surface:var(--color-elevated)]"
      aria-label={ariaLabel}
    />
  )
}

/**
 * Small, non-interactive map tile preview for location pickers. Shows
 * `MapSourceGate` until a usable source exists; then loads protomaps
 * (offline), MapTiler raster tiles, or a MapKit preview.
 */
export function LocationMapPreview({
  latitude,
  longitude,
  ariaLabel,
  liveDescription,
  className,
}: LocationMapPreviewProps) {
  const { usable, isLoading } = useMapSourceUsable()
  const { source } = useMapSourceSettings()

  const liveRegion = (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {liveDescription}
    </p>
  )

  if (isLoading || !usable) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        {liveRegion}
        {isLoading ? (
          <div className="border-border-default bg-elevated h-32 w-full animate-pulse rounded-xl border" />
        ) : (
          <MapSourceGate variant="inline" />
        )}
      </div>
    )
  }

  return (
    <div className={cn('relative flex flex-col gap-1', className)}>
      {liveRegion}
      {source === 'mapkit' ? (
        <MapKitPreview
          latitude={latitude}
          longitude={longitude}
          ariaLabel={ariaLabel}
          className="h-32 w-full rounded-xl outline-none"
        />
      ) : (
        <LocationMapPreviewCanvas latitude={latitude} longitude={longitude} ariaLabel={ariaLabel} />
      )}
    </div>
  )
}

interface LocationMapPreviewPlaceholderProps {
  message: string
  className?: string
}

/** Muted placeholder shown before a suggestion with coordinates is available. */
export function LocationMapPreviewPlaceholder({
  message,
  className,
}: LocationMapPreviewPlaceholderProps) {
  return (
    <div
      className={cn(
        'border-border-default bg-elevated text-fg-muted flex h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border px-3 text-center text-xs',
        className,
      )}
      role="status"
    >
      <MapPin className="size-5 opacity-60" strokeWidth={1.75} aria-hidden />
      <span className="leading-snug">{message}</span>
    </div>
  )
}
