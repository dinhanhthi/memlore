import { describe, it, expect } from 'vitest'
import { capList } from './capList'

describe('capList', () => {
  it('returns all items unmarked as truncated when under the cap', () => {
    const result = capList([1, 2, 3], 10)
    expect(result).toEqual({ shown: [1, 2, 3], total: 3, truncated: false })
  })

  it('returns all items unmarked as truncated when exactly at the cap', () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const result = capList(items, 10)
    expect(result.shown).toEqual(items)
    expect(result.total).toBe(10)
    expect(result.truncated).toBe(false)
  })

  it('caps the shown list but reports the true total when over the cap', () => {
    const items = Array.from({ length: 19 }, (_, i) => i)
    const result = capList(items, 10)
    expect(result.shown).toEqual(items.slice(0, 10))
    expect(result.total).toBe(19)
    expect(result.truncated).toBe(true)
  })

  it('handles an empty list', () => {
    expect(capList([], 10)).toEqual({ shown: [], total: 0, truncated: false })
  })
})
