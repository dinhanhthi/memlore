export type GeocodingProvider = 'nominatim' | 'photon' | 'mapbox' | 'maptiler' | 'google'

export interface GeocodeSuggestion {
  place_id: string
  label: string
  address: string
  latitude: number
  longitude: number
}
