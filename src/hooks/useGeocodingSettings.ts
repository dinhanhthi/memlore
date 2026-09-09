import { useCallback, useEffect, useState } from 'react'
import { getSetting, setSetting } from '../lib/tauri'

export type GeocodingProvider = 'nominatim' | 'photon' | 'mapbox' | 'maptiler' | 'google'

export interface GeocodingSettings {
  provider: GeocodingProvider
  mapboxKey: string
  googleKey: string
  isLoading: boolean
  setProvider: (p: GeocodingProvider) => Promise<void>
  setMapboxKey: (k: string) => Promise<void>
  setGoogleKey: (k: string) => Promise<void>
}

const VALID_PROVIDERS: GeocodingProvider[] = ['nominatim', 'photon', 'mapbox', 'maptiler', 'google']

function isGeocodingProvider(value: unknown): value is GeocodingProvider {
  return VALID_PROVIDERS.includes(value as GeocodingProvider)
}

function parseProvider(raw: string | null | undefined): GeocodingProvider {
  return isGeocodingProvider(raw) ? raw : 'photon'
}

function parseKey(raw: string | null | undefined): string {
  return raw ?? ''
}

// ── Module-level cache for imperative (non-React) access ──────────────
let cachedProvider: GeocodingProvider = 'photon'
let geocodingProviderHydrated = false

/** Hydrate the module cache from SQLite. Safe to call multiple times. */
export async function hydrateGeocodingProvider(): Promise<void> {
  try {
    cachedProvider = parseProvider(await getSetting('geocoding_provider'))
    geocodingProviderHydrated = true
  } catch {
    // Leave default.
  }
}

/** Non-reactive read — for command palette and non-React callers. */
export function getGeocodingProvider(): GeocodingProvider {
  return cachedProvider
}

export function isGeocodingProviderHydrated(): boolean {
  return geocodingProviderHydrated
}

/// `useGeocodingSettings` — reads and writes the three geocoding settings
/// (`geocoding_provider`, `mapbox_api_key`, `google_api_key`) from SQLite
/// via `getSetting`/`setSetting`.
///
/// - On mount, all three keys are loaded in parallel.
/// - `isLoading` is true until the initial load resolves.
/// - `setProvider` validates its argument against the enum and throws for
///   unknown values without calling `setSetting`.
/// - `setMapboxKey` / `setGoogleKey` persist then update local state.
/// - Changing the provider does NOT touch the stored keys.
export function useGeocodingSettings(): GeocodingSettings {
  const [provider, setProviderState] = useState<GeocodingProvider>('photon')
  const [mapboxKey, setMapboxKeyState] = useState<string>('')
  const [googleKey, setGoogleKeyState] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(true)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [rawProvider, rawMapbox, rawGoogle] = await Promise.all([
          getSetting('geocoding_provider'),
          getSetting('mapbox_api_key'),
          getSetting('google_api_key'),
        ])
        if (cancelled) return
        setProviderState(parseProvider(rawProvider))
        cachedProvider = parseProvider(rawProvider)
        geocodingProviderHydrated = true
        setMapboxKeyState(parseKey(rawMapbox))
        setGoogleKeyState(parseKey(rawGoogle))
      } catch (err) {
        if (import.meta.env.MODE !== 'test') {
          console.error('[useGeocodingSettings] failed to load settings:', err)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const setProvider = useCallback(async (p: GeocodingProvider) => {
    if (!isGeocodingProvider(p)) {
      throw new Error(`Invalid geocoding provider: ${String(p)}`)
    }
    await setSetting('geocoding_provider', p)
    setProviderState(p)
  }, [])

  const setMapboxKey = useCallback(async (k: string) => {
    await setSetting('mapbox_api_key', k)
    setMapboxKeyState(k)
  }, [])

  const setGoogleKey = useCallback(async (k: string) => {
    await setSetting('google_api_key', k)
    setGoogleKeyState(k)
  }, [])

  return {
    provider,
    mapboxKey,
    googleKey,
    isLoading,
    setProvider,
    setMapboxKey,
    setGoogleKey,
  }
}
