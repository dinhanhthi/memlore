import { describe, expect, it } from 'vitest'
import type { MapPin } from '../types/map'
import { groupPinsByPlace } from './mapPlaces'

function pin(over: Partial<MapPin> & Pick<MapPin, 'entryId'>): MapPin {
  return {
    id: `entry:${over.entryId}`,
    kind: 'entry',
    latitude: 10,
    longitude: 106,
    label: null,
    entryDate: 0,
    thumbnailPath: null,
    ...over,
  }
}

describe('groupPinsByPlace', () => {
  it('returns no places for no pins', () => {
    expect(groupPinsByPlace([])).toEqual([])
  })

  it('groups labelled pins by trimmed label, most entries first, newest entry first', () => {
    const places = groupPinsByPlace([
      pin({ entryId: 'a', label: 'Hanoi', entryDate: 100 }),
      pin({ entryId: 'b', label: 'Paris', entryDate: 300 }),
      pin({ entryId: 'c', label: ' Hanoi ', entryDate: 200 }),
    ])
    expect(places.map((p) => p.label)).toEqual(['Hanoi', 'Paris'])
    expect(places[0].entries.map((e) => e.entryId)).toEqual(['c', 'a'])
  })

  it('lists an entry once per place even when several pins point at it', () => {
    const places = groupPinsByPlace([
      pin({ entryId: 'a', label: 'Hanoi', entryDate: 100 }),
      pin({ id: 'photo:p1', kind: 'photo', entryId: 'a', label: 'Hanoi', entryDate: 100 }),
    ])
    expect(places).toHaveLength(1)
    expect(places[0].entries).toEqual([{ entryId: 'a', entryDate: 100 }])
  })

  it('groups unlabelled pins by rounded coordinates and keeps their label null', () => {
    const places = groupPinsByPlace([
      pin({ entryId: 'a', label: null, latitude: 21.0281, longitude: 105.8542 }),
      pin({ entryId: 'b', label: '  ', latitude: 21.0262, longitude: 105.8519 }),
      pin({ entryId: 'c', label: null, latitude: 48.8566, longitude: 2.3522 }),
    ])
    expect(places).toHaveLength(2)
    expect(places[0].label).toBeNull()
    expect(places[0].entries.map((e) => e.entryId).sort()).toEqual(['a', 'b'])
    expect(places[0].latitude).toBeCloseTo(21.0281)
  })

  it('never merges a labelled place with an unlabelled one at the same spot', () => {
    const places = groupPinsByPlace([
      pin({ entryId: 'a', label: 'Hanoi' }),
      pin({ entryId: 'b', label: null }),
    ])
    expect(places).toHaveLength(2)
  })
})
