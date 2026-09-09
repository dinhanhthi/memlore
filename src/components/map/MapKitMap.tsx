import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { useTheme } from '../../hooks/useTheme'
import { getMapkitToken } from '../../lib/tauri'
import {
  loadMapkit,
  mapkitColorScheme,
  type MapKitAnnotation,
  type MapKitAPI,
  type MapKitMapInstance,
} from '../../lib/mapkitLoader'
import type { MapPin } from '../../types/map'

const CLUSTERING_ID = 'memlore-entries'
const DEFAULT_CENTER: [number, number] = [20, 0]
const DEFAULT_SPAN: [number, number] = [80, 160]

export interface MapKitMapProps {
  pins: MapPin[]
  onPinClick: (pin: MapPin) => void
  className?: string
}

function isMapPin(value: unknown): value is MapPin {
  if (typeof value !== 'object' || value === null) return false
  const rec = value as Record<string, unknown>
  return typeof rec.entryId === 'string' && typeof rec.latitude === 'number'
}

function MapKitMapCanvas({ pins, onPinClick, className }: MapKitMapProps) {
  const { t } = useTranslation('common')
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapKitMapInstance | null>(null)
  const mapkitRef = useRef<MapKitAPI | null>(null)
  const annotationsRef = useRef<MapKitAnnotation[]>([])
  const onPinClickRef = useRef(onPinClick)
  const themeRef = useRef(resolvedTheme)
  onPinClickRef.current = onPinClick
  themeRef.current = resolvedTheme

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
        mapkitRef.current = mapkit

        if (!mapRef.current) {
          mapRef.current = new mapkit.Map(containerRef.current, {
            colorScheme: mapkitColorScheme(mapkit, themeRef.current),
            showsMapTypeControl: false,
            showsUserLocationControl: false,
            region: new mapkit.CoordinateRegion(
              new mapkit.Coordinate(DEFAULT_CENTER[0], DEFAULT_CENTER[1]),
              new mapkit.CoordinateSpan(DEFAULT_SPAN[0], DEFAULT_SPAN[1]),
            ),
          })
        }

        const map = mapRef.current
        if (annotationsRef.current.length > 0) {
          map.removeAnnotations(annotationsRef.current)
          annotationsRef.current = []
        }

        const annotations = pins.map((pin) => {
          const annotation = new mapkit.MarkerAnnotation(
            new mapkit.Coordinate(pin.latitude, pin.longitude),
            {
              title: pin.label ?? undefined,
              clusteringIdentifier: CLUSTERING_ID,
              data: pin,
            },
          )
          annotation.addEventListener('select', (event) => {
            if (isMapPin(event.target.data)) {
              onPinClickRef.current(event.target.data)
            }
          })
          return annotation
        })
        annotationsRef.current = annotations
        if (annotations.length > 0) {
          map.addAnnotations(annotations)
          map.showItems(annotations, {
            animate: false,
            padding: { top: 40, right: 40, bottom: 40, left: 40 },
          })
        }
      } catch {
        console.error('[MapKitMap] failed to initialize')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [pins])

  useEffect(() => {
    const map = mapRef.current
    const mapkit = mapkitRef.current
    if (!map || !mapkit) return
    map.colorScheme = mapkitColorScheme(mapkit, resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
        mapkitRef.current = null
        annotationsRef.current = []
      }
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={className}
      aria-label={t('map.aria_label')}
      data-testid="mapkit-map"
    />
  )
}

export function MapKitMap({ pins, onPinClick, className }: MapKitMapProps) {
  const { t } = useTranslation('common')
  const fallbackSizing = className ? '' : 'min-h-75 w-full'

  if (pins.length === 0) {
    return (
      <div
        className={cn(fallbackSizing, 'flex items-center justify-center p-8', className)}
        role="status"
        aria-label={t('map.aria_label')}
        data-testid="mapkit-map-empty"
      >
        <p className="text-fg-muted text-sm">{t('map.empty')}</p>
      </div>
    )
  }

  return (
    <MapKitMapCanvas
      pins={pins}
      onPinClick={onPinClick}
      className={cn(fallbackSizing, className)}
    />
  )
}
