import type { MapPin } from '../types/map'

export interface MapPlaceEntry {
  entryId: string
  entryDate: number
}

/** Pins that share a place: one `label`, or (no label) the same ~1 km cell. */
export interface MapPlace {
  key: string
  /** `null` = the pins had no place name; show the coordinates instead. */
  label: string | null
  latitude: number
  longitude: number
  /** One row per entry, newest first. */
  entries: MapPlaceEntry[]
}

function placeKey(label: string | null, pin: MapPin): string {
  if (label !== null) return `label:${label}`
  return `coords:${pin.latitude.toFixed(2)},${pin.longitude.toFixed(2)}`
}

/** Groups map pins into places for the web places list: most entries first,
 *  then the place with the newest entry. */
export function groupPinsByPlace(pins: readonly MapPin[]): MapPlace[] {
  const places = new Map<string, MapPlace>()
  for (const pin of pins) {
    const label = pin.label?.trim() || null
    const key = placeKey(label, pin)
    let place = places.get(key)
    if (!place) {
      place = { key, label, latitude: pin.latitude, longitude: pin.longitude, entries: [] }
      places.set(key, place)
    }
    if (!place.entries.some((e) => e.entryId === pin.entryId)) {
      place.entries.push({ entryId: pin.entryId, entryDate: pin.entryDate })
    }
  }
  const result = [...places.values()]
  for (const place of result) place.entries.sort((a, b) => b.entryDate - a.entryDate)
  return result.sort(
    (a, b) =>
      b.entries.length - a.entries.length ||
      (b.entries[0]?.entryDate ?? 0) - (a.entries[0]?.entryDate ?? 0),
  )
}
