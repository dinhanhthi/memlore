import { updateEntryLocation } from '../lib/tauri'
import { useEntryLocationPendingStore } from '../stores/entryLocationPendingStore'
import type { LocationAlias } from '../types/location'
import { applyEntryWeather } from './applyEntryWeather'
import { emitEntriesChanged, emitEntryPatched } from './useEntries'

/**
 * Persist a saved location alias onto an entry.
 *
 * Marks the entry pending synchronously so the card / editor can show
 * a loading slot, then writes coords + label. Weather is best-effort
 * and must not hold the loading state (it is the slow network hop).
 */
export async function applyLocationAliasToEntry(
  entryId: string,
  alias: LocationAlias,
  entryDate: number,
): Promise<void> {
  const store = useEntryLocationPendingStore.getState()
  store.begin(entryId)
  try {
    const updated = await updateEntryLocation(
      entryId,
      alias.latitude,
      alias.longitude,
      alias.label,
      alias.address,
    )
    emitEntryPatched(entryId, {
      latitude: updated.latitude,
      longitude: updated.longitude,
      location_label: updated.location_label,
      location_address: updated.location_address,
    })
    emitEntriesChanged()
  } catch (err) {
    console.error('Failed to set entry location from alias:', err)
    return
  } finally {
    store.end(entryId)
  }

  const weatherUpdated = await applyEntryWeather(
    entryId,
    alias.latitude,
    alias.longitude,
    entryDate,
  )
  if (weatherUpdated) {
    emitEntryPatched(entryId, {
      weather_summary: weatherUpdated.weather_summary,
      weather_icon: weatherUpdated.weather_icon,
    })
  }
}
