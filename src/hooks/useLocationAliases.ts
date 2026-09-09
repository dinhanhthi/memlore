import { useEffect, useState, useCallback, useSyncExternalStore } from 'react'
import {
  listLocationAliases,
  createLocationAlias as tauriCreateLocationAlias,
  updateLocationAlias as tauriUpdateLocationAlias,
  deleteLocationAlias as tauriDeleteLocationAlias,
} from '../lib/tauri'
import type { LocationAlias } from '../types/location'

// Module-level cache shared across all hook instances (replaces a former
// Zustand store). Do NOT swap for useState: LocationSettings and
// DefaultLocationForm mount simultaneously and mutations in one must
// reflect in the other.
let aliasesCache: LocationAlias[] = []
const listeners = new Set<() => void>()
const getAliases = () => aliasesCache
const setAliases = (aliases: LocationAlias[]) => {
  aliasesCache = aliases
  listeners.forEach((listener) => listener())
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: clear the module-level cache between test cases. Does not
 * notify listeners — call only while no hook instance is mounted. */
export function __resetLocationAliasesForTests() {
  aliasesCache = []
}

export function useLocationAliases() {
  const aliases = useSyncExternalStore(subscribe, getAliases)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAliases = useCallback(() => {
    setIsLoading(true)
    setError(null)

    listLocationAliases()
      .then((fetched: LocationAlias[]) => {
        setAliases(fetched)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setIsLoading(false)
      })
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    fetchAliases()
  }, [fetchAliases])

  const createAlias = async (
    label: string,
    address: string,
    latitude: number,
    longitude: number,
    radiusMeters?: number,
  ): Promise<LocationAlias> => {
    const alias = await tauriCreateLocationAlias(label, address, latitude, longitude, radiusMeters)
    const updated = await listLocationAliases()
    setAliases(updated)
    return alias
  }

  const updateAlias = async (
    id: string,
    label: string,
    address: string,
    latitude: number,
    longitude: number,
    radiusMeters?: number,
  ): Promise<LocationAlias> => {
    const alias = await tauriUpdateLocationAlias(
      id,
      label,
      address,
      latitude,
      longitude,
      radiusMeters,
    )
    const updated = await listLocationAliases()
    setAliases(updated)
    return alias
  }

  const deleteAlias = async (id: string): Promise<void> => {
    await tauriDeleteLocationAlias(id)
    const updated = await listLocationAliases()
    setAliases(updated)
  }

  return {
    aliases,
    isLoading,
    error,
    createAlias,
    updateAlias,
    deleteAlias,
    refresh: fetchAliases,
  }
}
