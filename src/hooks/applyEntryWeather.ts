import { fetchWeather, updateEntryWeather } from '../lib/tauri'
import type { Entry } from '../types/entry'

/**
 * Best-effort weather fetch for an entry's location on its entry date.
 * Returns the updated entry when weather was saved, or null on failure.
 */
export async function applyEntryWeather(
  entryId: string,
  latitude: number,
  longitude: number,
  entryDate: number,
): Promise<Entry | null> {
  try {
    const weather = await fetchWeather(latitude, longitude, entryDate)
    return await updateEntryWeather(entryId, weather.summary, weather.icon)
  } catch {
    return null
  }
}
