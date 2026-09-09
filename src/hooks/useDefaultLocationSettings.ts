import { useCallback, useEffect, useState } from 'react'
import { getSetting, setSetting } from '../lib/tauri'

export interface DefaultLocationSettings {
  enabled: boolean
  label: string
  address: string
  lat: number | null
  lng: number | null
  isLoading: boolean
  setEnabled: (v: boolean) => Promise<void>
  setLocation: (
    label: string,
    address: string,
    lat: number | null,
    lng: number | null,
  ) => Promise<void>
  clearLocation: () => Promise<void>
}

const SETTING_ENABLED = 'default_location_enabled'
const SETTING_LABEL = 'default_location_label'
const SETTING_ADDRESS = 'default_location_address'
const SETTING_LAT = 'default_location_lat'
const SETTING_LNG = 'default_location_lng'

function parseCoord(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

// ── Module-level cache for imperative (non-React) access ──────────────
let cachedEnabled = false
let locationEnabledHydrated = false

/** Hydrate the module cache from SQLite. Safe to call multiple times. */
export async function hydrateDefaultLocationEnabled(): Promise<void> {
  try {
    cachedEnabled = (await getSetting(SETTING_ENABLED)) === 'true'
    locationEnabledHydrated = true
  } catch {
    // Leave default.
  }
}

/** Non-reactive read — for command palette and non-React callers. */
export function getDefaultLocationEnabled(): boolean {
  return cachedEnabled
}

export function isDefaultLocationEnabledHydrated(): boolean {
  return locationEnabledHydrated
}

/** Imperative setter — for command palette and non-React callers. */
export async function setDefaultLocationEnabledImperative(v: boolean): Promise<void> {
  await setSetting(SETTING_ENABLED, v ? 'true' : 'false')
  cachedEnabled = v
  locationEnabledHydrated = true
}

/// `useDefaultLocationSettings` — reads and writes the five default-location
/// settings keys from SQLite via `getSetting`/`setSetting`.
///
/// - On mount, all five keys are loaded in parallel.
/// - `isLoading` is true until the initial load resolves.
/// - `setEnabled` persists the boolean as the string "true" / "false".
/// - `setLocation` persists label, address, lat, lng together.
/// - `clearLocation` removes label, address, lat, lng (sets them to empty string).
export function useDefaultLocationSettings(): DefaultLocationSettings {
  const [enabled, setEnabledState] = useState(false)
  const [label, setLabelState] = useState('')
  const [address, setAddressState] = useState('')
  const [lat, setLatState] = useState<number | null>(null)
  const [lng, setLngState] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [rawEnabled, rawLabel, rawAddress, rawLat, rawLng] = await Promise.all([
          getSetting(SETTING_ENABLED),
          getSetting(SETTING_LABEL),
          getSetting(SETTING_ADDRESS),
          getSetting(SETTING_LAT),
          getSetting(SETTING_LNG),
        ])
        if (cancelled) return
        setEnabledState(rawEnabled === 'true')
        cachedEnabled = rawEnabled === 'true'
        locationEnabledHydrated = true
        setLabelState(rawLabel ?? '')
        setAddressState(rawAddress ?? '')
        setLatState(parseCoord(rawLat))
        setLngState(parseCoord(rawLng))
      } catch (err) {
        if (import.meta.env.MODE !== 'test') {
          console.error('[useDefaultLocationSettings] failed to load settings:', err)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = useCallback(async (v: boolean) => {
    await setSetting(SETTING_ENABLED, v ? 'true' : 'false')
    setEnabledState(v)
    cachedEnabled = v
    locationEnabledHydrated = true
  }, [])

  const setLocation = useCallback(
    async (newLabel: string, newAddress: string, newLat: number | null, newLng: number | null) => {
      await Promise.all([
        setSetting(SETTING_LABEL, newLabel),
        setSetting(SETTING_ADDRESS, newAddress),
        setSetting(SETTING_LAT, newLat !== null ? String(newLat) : ''),
        setSetting(SETTING_LNG, newLng !== null ? String(newLng) : ''),
      ])
      setLabelState(newLabel)
      setAddressState(newAddress)
      setLatState(newLat)
      setLngState(newLng)
    },
    [],
  )

  const clearLocation = useCallback(async () => {
    await Promise.all([
      setSetting(SETTING_LABEL, ''),
      setSetting(SETTING_ADDRESS, ''),
      setSetting(SETTING_LAT, ''),
      setSetting(SETTING_LNG, ''),
    ])
    setLabelState('')
    setAddressState('')
    setLatState(null)
    setLngState(null)
  }, [])

  return {
    enabled,
    label,
    address,
    lat,
    lng,
    isLoading,
    setEnabled,
    setLocation,
    clearLocation,
  }
}
