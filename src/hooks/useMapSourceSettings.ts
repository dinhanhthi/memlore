import { useCallback, useEffect, useRef, useState } from 'react'
import type { BasemapStatusKind } from '../lib/tauri'
import { getMapkitToken, getSetting, setSetting } from '../lib/tauri'

/** Persisted `map_tile_source` values. */
export const MAP_TILE_SOURCES = ['offline', 'maptiler', 'mapkit'] as const
export type MapTileSource = (typeof MAP_TILE_SOURCES)[number]

export interface MapSourceSettings {
  source: MapTileSource | null
  maptilerKey: string
  isLoading: boolean
  /** True when the compile-time MapKit JWT is present. UI-level token gate. */
  mapkitAvailable: boolean
  setSource: (source: MapTileSource) => Promise<void>
  setMaptilerKey: (key: string) => Promise<void>
}

function isMapTileSource(value: unknown): value is MapTileSource {
  return (MAP_TILE_SOURCES as readonly string[]).includes(value as string)
}

function parseSource(raw: string | null | undefined): MapTileSource | null {
  if (raw == null || raw === '') return null
  return isMapTileSource(raw) ? raw : null
}

function parseKey(raw: string | null | undefined): string {
  return raw ?? ''
}

/** True when Locations / heatmap / previews may render tiles. */
export function isMapSourceUsable(
  source: MapTileSource | null,
  maptilerKey: string,
  basemapStatus: BasemapStatusKind,
  mapkitAvailable = false,
): boolean {
  switch (source) {
    case 'offline':
      return basemapStatus === 'ready'
    case 'maptiler':
      return maptilerKey.trim().length > 0
    case 'mapkit':
      return mapkitAvailable
    default:
      return false
  }
}

/** Decimal GB for copy (`552165687` → `"0.55"`). */
export function formatBasemapSizeGb(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(2)
}

interface MapSourceSnapshot {
  source: MapTileSource | null
  maptilerKey: string
}

const listeners = new Set<(snap: MapSourceSnapshot) => void>()

let lastMapSourceSnapshot: MapSourceSnapshot = { source: null, maptilerKey: '' }

function publishMapSource(snap: MapSourceSnapshot) {
  lastMapSourceSnapshot = snap
  for (const listener of listeners) listener(snap)
}

/** Persist `map_tile_source=""` and broadcast `source: null` so live
 *  `useMapSourceSettings` listeners drop Offline without waiting for remount.
 *  Preserves the last known MapTiler key. Safe to call with no hook mounted. */
export async function clearMapTileSource(): Promise<void> {
  await setSetting('map_tile_source', '')
  publishMapSource({ source: null, maptilerKey: lastMapSourceSnapshot.maptilerKey })
}

/// `useMapSourceSettings` — reads and writes `map_tile_source` and
/// `maptiler_api_key` from SQLite via `getSetting`/`setSetting`.
///
/// - Default is **unset** (`null`): missing or `""` does not pick a source.
/// - `setSource` validates against `MAP_TILE_SOURCES` and throws for
///   unknown values without calling `setSetting`.
/// - Changing the source does NOT touch the stored MapTiler key.
export function useMapSourceSettings(): MapSourceSettings {
  const [source, setSourceState] = useState<MapTileSource | null>(null)
  const [maptilerKey, setMaptilerKeyState] = useState<string>('')
  const [mapkitAvailable, setMapkitAvailable] = useState(false)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const snapRef = useRef<MapSourceSnapshot>({ source: null, maptilerKey: '' })
  snapRef.current = { source, maptilerKey }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [rawSource, rawKey, mapkit] = await Promise.all([
          getSetting('map_tile_source'),
          getSetting('maptiler_api_key'),
          getMapkitToken().catch(() => ({ available: false as const })),
        ])
        if (cancelled) return
        const nextSource = parseSource(rawSource)
        const nextKey = parseKey(rawKey)
        setSourceState(nextSource)
        setMaptilerKeyState(nextKey)
        lastMapSourceSnapshot = { source: nextSource, maptilerKey: nextKey }
        setMapkitAvailable(mapkit.available)
      } catch (err) {
        if (import.meta.env.MODE !== 'test') {
          console.error('[useMapSourceSettings] failed to load settings:', err)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    })()

    const onPublish = (snap: MapSourceSnapshot) => {
      setSourceState(snap.source)
      setMaptilerKeyState(snap.maptilerKey)
    }
    listeners.add(onPublish)

    return () => {
      cancelled = true
      listeners.delete(onPublish)
    }
  }, [])

  const setSource = useCallback(async (next: MapTileSource) => {
    if (!isMapTileSource(next)) {
      throw new Error(`Invalid map tile source: ${String(next)}`)
    }
    await setSetting('map_tile_source', next)
    const snap = { source: next, maptilerKey: snapRef.current.maptilerKey }
    setSourceState(next)
    publishMapSource(snap)
  }, [])

  const setMaptilerKey = useCallback(async (key: string) => {
    await setSetting('maptiler_api_key', key)
    const snap = { source: snapRef.current.source, maptilerKey: key }
    setMaptilerKeyState(key)
    publishMapSource(snap)
  }, [])

  return {
    source,
    maptilerKey,
    isLoading,
    mapkitAvailable,
    setSource,
    setMaptilerKey,
  }
}
