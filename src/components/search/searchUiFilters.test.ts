import { describe, expect, it } from 'vitest'
import { defaultSearchUiFilters, hasAnyFilter } from './searchUiFilters'

describe('hasAnyFilter', () => {
  it('returns false for default filters', () => {
    expect(hasAnyFilter(defaultSearchUiFilters)).toBe(false)
  })

  it('returns true when range is non-all', () => {
    expect(hasAnyFilter({ ...defaultSearchUiFilters, range: { kind: 'thisWeek' } })).toBe(true)
  })

  it('returns true when journalIds is non-empty', () => {
    expect(hasAnyFilter({ ...defaultSearchUiFilters, journalIds: ['j1'] })).toBe(true)
  })

  it('returns true when tagIds is non-empty', () => {
    expect(hasAnyFilter({ ...defaultSearchUiFilters, tagIds: ['t1'] })).toBe(true)
  })

  it('returns true when emotions is non-empty', () => {
    expect(hasAnyFilter({ ...defaultSearchUiFilters, emotions: ['good'] })).toBe(true)
  })

  it('returns true when hasMedia is "has"', () => {
    expect(hasAnyFilter({ ...defaultSearchUiFilters, hasMedia: 'has' })).toBe(true)
  })

  it('returns true when hasMedia is "none"', () => {
    expect(hasAnyFilter({ ...defaultSearchUiFilters, hasMedia: 'none' })).toBe(true)
  })
})
