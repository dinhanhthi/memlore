import { useEffect, useRef } from 'react'
import { useTheme } from '../../hooks/useTheme'
import { getMapkitToken } from '../../lib/tauri'
import {
  loadMapkit,
  mapkitColorScheme,
  type MapKitAnnotation,
  type MapKitMapInstance,
} from '../../lib/mapkitLoader'

const PREVIEW_SPAN = 0.02

interface MapKitPreviewProps {
  latitude: number
  longitude: number
  ariaLabel: string
  className?: string
}

/** Small non-interactive MapKit map for the location-preview slot. */
export function MapKitPreview({ latitude, longitude, ariaLabel, className }: MapKitPreviewProps) {
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapKitMapInstance | null>(null)
  const annotationRef = useRef<MapKitAnnotation | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false

    void (async () => {
      try {
        const token = await getMapkitToken()
        if (cancelled || !token.available) return
        const mapkit = await loadMapkit(token.token)
        if (cancelled || !containerRef.current) return

        const center = new mapkit.Coordinate(latitude, longitude)
        const region = new mapkit.CoordinateRegion(
          center,
          new mapkit.CoordinateSpan(PREVIEW_SPAN, PREVIEW_SPAN),
        )
        const scheme = mapkitColorScheme(mapkit, resolvedTheme)

        if (!mapRef.current) {
          mapRef.current = new mapkit.Map(containerRef.current, {
            colorScheme: scheme,
            isScrollEnabled: false,
            isZoomEnabled: false,
            isRotationEnabled: false,
            showsMapTypeControl: false,
            showsZoomControl: false,
            showsUserLocationControl: false,
            region,
          })
        } else {
          mapRef.current.colorScheme = scheme
          mapRef.current.region = region
        }

        const map = mapRef.current
        if (annotationRef.current) {
          map.removeAnnotations([annotationRef.current])
          annotationRef.current = null
        }
        const pin = new mapkit.MarkerAnnotation(center)
        annotationRef.current = pin
        map.addAnnotations([pin])
      } catch {
        console.error('[MapKitPreview] failed to initialize')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [latitude, longitude, resolvedTheme])

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
        annotationRef.current = null
      }
    }
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={className ?? 'h-32 w-full rounded-xl outline-none'}
      aria-label={ariaLabel}
      data-testid="mapkit-preview"
    />
  )
}
