import { describe, expect, it } from 'vitest'
import {
  buildLocationAliasDraft,
  hasValidLocationCoords,
  resolveLocationPreviewCoords,
  suggestionFromStoredLocation,
} from './locationCoords'
import type { GeocodeSuggestion } from '../types/geocoding'

const sug = (id: string, lat: number, lng: number): GeocodeSuggestion => ({
  place_id: id,
  label: id,
  address: `${id} address`,
  latitude: lat,
  longitude: lng,
})

describe('hasValidLocationCoords', () => {
  it('rejects the unresolved 0,0 sentinel', () => {
    expect(hasValidLocationCoords(0, 0)).toBe(false)
  })

  it('accepts any non-zero coordinate', () => {
    expect(hasValidLocationCoords(48.8566, 0)).toBe(true)
    expect(hasValidLocationCoords(0, 2.3522)).toBe(true)
    expect(hasValidLocationCoords(48.8566, 2.3522)).toBe(true)
  })
})

describe('resolveLocationPreviewCoords', () => {
  it('returns coords from the selected suggestion', () => {
    expect(resolveLocationPreviewCoords(sug('selected', 9, 9))).toEqual({
      latitude: 9,
      longitude: 9,
    })
  })

  it('returns null when there is no usable coordinate', () => {
    expect(resolveLocationPreviewCoords(sug('x', 0, 0))).toBeNull()
    expect(resolveLocationPreviewCoords(null)).toBeNull()
  })
})

describe('suggestionFromStoredLocation', () => {
  it('builds a suggestion when label, address, and coords are present', () => {
    expect(suggestionFromStoredLocation('Home', '123 Main St', 1, 2)).toEqual({
      place_id: 'stored',
      label: 'Home',
      address: '123 Main St',
      latitude: 1,
      longitude: 2,
    })
  })

  it('falls back to address for label when label is empty', () => {
    expect(suggestionFromStoredLocation('', '123 Main St', 1, 2)?.label).toBe('123 Main St')
  })

  it('returns null without address or valid coords', () => {
    expect(suggestionFromStoredLocation('Home', '', 1, 2)).toBeNull()
    expect(suggestionFromStoredLocation('Home', 'addr', null, 2)).toBeNull()
    expect(suggestionFromStoredLocation('Home', 'addr', 0, 0)).toBeNull()
  })
})

describe('buildLocationAliasDraft', () => {
  it('returns null when label or address is missing', () => {
    expect(
      buildLocationAliasDraft({ label: '', query: '123 Main', selectedSuggestion: null }),
    ).toBeNull()
    expect(
      buildLocationAliasDraft({ label: 'Home', query: '', selectedSuggestion: null }),
    ).toBeNull()
  })

  it('uses the selected suggestion address and coordinates', () => {
    expect(
      buildLocationAliasDraft({
        label: '  Home  ',
        query: 'typed',
        selectedSuggestion: sug('place', 10, 20),
      }),
    ).toEqual({
      label: 'Home',
      address: 'place address',
      latitude: 10,
      longitude: 20,
    })
  })

  it('falls back to the query and 0,0 when no suggestion is selected', () => {
    expect(
      buildLocationAliasDraft({
        label: 'Home',
        query: '  123 Main St  ',
        selectedSuggestion: null,
      }),
    ).toEqual({
      label: 'Home',
      address: '123 Main St',
      latitude: 0,
      longitude: 0,
    })
  })
})
