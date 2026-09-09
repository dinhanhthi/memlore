/**
 * Load Apple MapKit JS once and init with the compile-time JWT.
 *
 * The official script is injected as a tag — Apple-served content is treated
 * as data. No eval, no extra scripts, no inline handlers beyond `mapkit.init`.
 */

const MAPKIT_SCRIPT_SRC = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js'

export interface MapKitCoordinate {
  latitude: number
  longitude: number
}

export interface MapKitCoordinateSpan {
  latitudeDelta: number
  longitudeDelta: number
}

export interface MapKitCoordinateRegion {
  center: MapKitCoordinate
  span: MapKitCoordinateSpan
}

export interface MapKitAnnotation {
  coordinate: MapKitCoordinate
  data?: unknown
  addEventListener(type: string, listener: (event: MapKitAnnotationEvent) => void): void
}

export interface MapKitAnnotationEvent {
  target: MapKitAnnotation
}

export interface MapKitPadding {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

export interface MapKitMapInstance {
  colorScheme: string
  center: MapKitCoordinate
  region: MapKitCoordinateRegion
  addAnnotations(annotations: MapKitAnnotation[]): void
  removeAnnotations(annotations: MapKitAnnotation[]): void
  showItems(
    annotations: MapKitAnnotation[],
    options?: { animate?: boolean; padding?: MapKitPadding },
  ): void
  destroy(): void
}

export interface MapKitMapOptions {
  colorScheme?: string
  isScrollEnabled?: boolean
  isZoomEnabled?: boolean
  isRotationEnabled?: boolean
  showsMapTypeControl?: boolean
  showsZoomControl?: boolean
  showsCompass?: boolean | string
  showsUserLocationControl?: boolean
  center?: MapKitCoordinate
  region?: MapKitCoordinateRegion
}

export interface MapKitMarkerAnnotationOptions {
  title?: string
  clusteringIdentifier?: string
  data?: unknown
}

export interface MapKitAPI {
  init(options: { authorizationCallback: (done: (token: string) => void) => void }): void
  Map: {
    new (element: HTMLElement, options?: MapKitMapOptions): MapKitMapInstance
    ColorSchemes: { Light: string; Dark: string }
  }
  MarkerAnnotation: {
    new (coordinate: MapKitCoordinate, options?: MapKitMarkerAnnotationOptions): MapKitAnnotation
  }
  Coordinate: {
    new (latitude: number, longitude: number): MapKitCoordinate
  }
  CoordinateSpan: {
    new (latitudeDelta: number, longitudeDelta: number): MapKitCoordinateSpan
  }
  CoordinateRegion: {
    new (center: MapKitCoordinate, span: MapKitCoordinateSpan): MapKitCoordinateRegion
  }
}

type WindowWithMapkit = Window & { mapkit?: MapKitAPI }

function windowMapkit(): MapKitAPI | undefined {
  return (window as WindowWithMapkit).mapkit
}

let loadPromise: Promise<MapKitAPI> | null = null

function initMapkit(mapkit: MapKitAPI, token: string): void {
  try {
    mapkit.init({
      authorizationCallback: (done) => {
        done(token)
      },
    })
  } catch {
    // Already initialized (HMR / second caller). Shared promise covers
    // the normal path; this catch is for a leftover window.mapkit.
  }
}

export function mapkitColorScheme(mapkit: MapKitAPI, resolvedTheme: 'light' | 'dark'): string {
  return resolvedTheme === 'dark' ? mapkit.Map.ColorSchemes.Dark : mapkit.Map.ColorSchemes.Light
}

/** Inject the official MapKit JS script once and init with `token`. */
export function loadMapkit(token: string): Promise<MapKitAPI> {
  if (loadPromise) return loadPromise

  loadPromise = new Promise<MapKitAPI>((resolve, reject) => {
    const existing = windowMapkit()
    if (existing) {
      initMapkit(existing, token)
      resolve(existing)
      return
    }

    const script = document.createElement('script')
    script.src = MAPKIT_SCRIPT_SRC
    script.async = true
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      const mapkit = windowMapkit()
      if (!mapkit) {
        reject(new Error('mapkit_script_missing'))
        return
      }
      initMapkit(mapkit, token)
      resolve(mapkit)
    }
    script.onerror = () => {
      reject(new Error('mapkit_script_failed'))
    }
    document.head.appendChild(script)
  }).catch((err: unknown) => {
    loadPromise = null
    throw err
  })

  return loadPromise
}
