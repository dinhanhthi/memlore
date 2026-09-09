import { describe, it, expect } from 'vitest'
import { mapSearchFilters } from './searchFiltersMapping'
import { defaultSearchUiFilters, type SearchUiFilters } from '../components/search/searchUiFilters'

describe('mapSearchFilters', () => {
  it('returns undefined for default UI state (no active filters)', () => {
    expect(mapSearchFilters(defaultSearchUiFilters)).toBeUndefined()
  })

  it('produces timeRange with sane bounds for thisMonth', () => {
    const ui: SearchUiFilters = { ...defaultSearchUiFilters, range: { kind: 'thisMonth' } }
    const result = mapSearchFilters(ui)
    expect(result).toBeDefined()
    expect(result?.timeRange).toBeDefined()
    const { from, toExclusive } = result!.timeRange!
    expect(from).toBeLessThan(toExclusive)
  })

  it('omits timeRange when custom range has null fromDateIso', () => {
    const ui: SearchUiFilters = {
      ...defaultSearchUiFilters,
      range: { kind: 'custom', fromDateIso: null, toDateIso: '2024-12-31' },
    }
    const result = mapSearchFilters(ui)
    // timeRange should not be present (bounds returns null for incomplete custom range)
    expect(result?.timeRange).toBeUndefined()
  })

  it('includes journalIds when non-empty', () => {
    const ui: SearchUiFilters = { ...defaultSearchUiFilters, journalIds: ['j1', 'j2'] }
    const result = mapSearchFilters(ui)
    expect(result?.journalIds).toEqual(['j1', 'j2'])
  })

  it('includes emotions when non-empty', () => {
    const ui: SearchUiFilters = { ...defaultSearchUiFilters, emotions: ['good'] }
    const result = mapSearchFilters(ui)
    expect(result?.emotions).toEqual(['good'])
  })

  it('omits hasMedia when "any", includes it when "has"', () => {
    const uiAny: SearchUiFilters = { ...defaultSearchUiFilters, hasMedia: 'any' }
    expect(mapSearchFilters(uiAny)?.hasMedia).toBeUndefined()

    const uiHas: SearchUiFilters = { ...defaultSearchUiFilters, hasMedia: 'has' }
    const result = mapSearchFilters(uiHas)
    expect(result?.hasMedia).toBe('has')

    const uiNone: SearchUiFilters = { ...defaultSearchUiFilters, hasMedia: 'none' }
    expect(mapSearchFilters(uiNone)?.hasMedia).toBe('none')
  })

  it('returns all 5 fields when every filter is active', () => {
    const ui: SearchUiFilters = {
      range: { kind: 'thisYear' },
      journalIds: ['j1'],
      tagIds: ['t1'],
      emotions: ['bad'],
      hasMedia: 'none',
    }
    const result = mapSearchFilters(ui)
    expect(result).toBeDefined()
    expect(result?.timeRange).toBeDefined()
    expect(result?.journalIds).toEqual(['j1'])
    expect(result?.tagIds).toEqual(['t1'])
    expect(result?.emotions).toEqual(['bad'])
    expect(result?.hasMedia).toBe('none')
  })
})
