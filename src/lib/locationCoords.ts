import type { GeocodeSuggestion } from '../types/geocoding'

/**
 * True when coordinates are resolved — rejects the unresolved (0, 0) sentinel
 * used before `geocodeResolve` completes.
 */
export function hasValidLocationCoords(latitude: number, longitude: number): boolean {
  return latitude !== 0 || longitude !== 0
}

/** Map-preview coordinates from the committed suggestion only (not keyboard highlight). */
export function resolveLocationPreviewCoords(
  selectedSuggestion: GeocodeSuggestion | null,
): { latitude: number; longitude: number } | null {
  if (!selectedSuggestion) return null
  if (!hasValidLocationCoords(selectedSuggestion.latitude, selectedSuggestion.longitude)) {
    return null
  }

  return { latitude: selectedSuggestion.latitude, longitude: selectedSuggestion.longitude }
}

export interface LocationAliasDraft {
  label: string
  address: string
  latitude: number
  longitude: number
}

/** Build a save/apply payload from the location-creation form. */
export function buildLocationAliasDraft(input: {
  label: string
  query: string
  selectedSuggestion: GeocodeSuggestion | null
}): LocationAliasDraft | null {
  const label = input.label.trim()
  const address = (input.selectedSuggestion?.address ?? input.query).trim()
  if (!label || !address) return null
  const suggestion = input.selectedSuggestion
  const hasCoords =
    suggestion != null && hasValidLocationCoords(suggestion.latitude, suggestion.longitude)
  return {
    label,
    address,
    latitude: hasCoords && suggestion ? suggestion.latitude : 0,
    longitude: hasCoords && suggestion ? suggestion.longitude : 0,
  }
}

/** Build a synthetic suggestion for reopening a form with saved coordinates. */
export function suggestionFromStoredLocation(
  label: string,
  address: string,
  latitude: number | null,
  longitude: number | null,
): GeocodeSuggestion | null {
  if (!address.trim()) return null
  if (latitude === null || longitude === null) return null
  if (!hasValidLocationCoords(latitude, longitude)) return null

  return {
    place_id: 'stored',
    label: label.trim() || address,
    address,
    latitude,
    longitude,
  }
}
