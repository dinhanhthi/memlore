import { describe, expect, it } from 'vitest'
import { moodTrendBody } from './moodTrendBody'

describe('moodTrendBody', () => {
  it('returns skeleton while loading with no rows yet', () => {
    expect(moodTrendBody(true, [])).toBe('skeleton')
  })

  it('returns empty when every row has a zero total', () => {
    expect(moodTrendBody(false, [{ total: 0 }, { total: 0 }])).toBe('empty')
  })

  it('returns chart when any row has a non-zero total', () => {
    expect(moodTrendBody(false, [{ total: 0 }, { total: 2 }])).toBe('chart')
  })

  it('returns chart when loading but cached rows already have totals', () => {
    expect(moodTrendBody(true, [{ total: 1 }])).toBe('chart')
  })
})
