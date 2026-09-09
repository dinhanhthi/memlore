import { describe, expect, it } from 'vitest'
import { paginationWindow } from './paginationWindow'

describe('paginationWindow', () => {
  // Edge cases: total <= 1
  it('total=0 → [1]', () => {
    expect(paginationWindow(1, 0)).toEqual([1])
  })

  it('total=1 → [1]', () => {
    expect(paginationWindow(1, 1)).toEqual([1])
  })

  // No ellipses when total fits in the natural window
  it('total=5 → no ellipses, full range', () => {
    expect(paginationWindow(1, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('total=7 → no ellipses (default slot count = 7, exactly fits)', () => {
    expect(paginationWindow(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  // Current at start — no left ellipsis, single right ellipsis
  it('current=1, total=11 → [1, 2, 3, ellipsis-right, 11]', () => {
    expect(paginationWindow(1, 11)).toEqual([1, 2, 3, 'ellipsis-right', 11])
  })

  it('current=2, total=11 → [1, 2, 3, ellipsis-right, 11]', () => {
    expect(paginationWindow(2, 11)).toEqual([1, 2, 3, 'ellipsis-right', 11])
  })

  // Current in the middle — both ellipses
  it('current=5, total=11 → [1, ellipsis-left, 4, 5, 6, ellipsis-right, 11]', () => {
    expect(paginationWindow(5, 11)).toEqual([1, 'ellipsis-left', 4, 5, 6, 'ellipsis-right', 11])
  })

  // Current near end — left ellipsis, no right ellipsis
  it('current=10, total=11 → [1, ellipsis-left, 9, 10, 11]', () => {
    expect(paginationWindow(10, 11)).toEqual([1, 'ellipsis-left', 9, 10, 11])
  })

  it('current=11, total=11 → [1, ellipsis-left, 9, 10, 11]', () => {
    expect(paginationWindow(11, 11)).toEqual([1, 'ellipsis-left', 9, 10, 11])
  })

  // Larger range
  it('current=50, total=100 → [1, ellipsis-left, 49, 50, 51, ellipsis-right, 100]', () => {
    expect(paginationWindow(50, 100)).toEqual([
      1,
      'ellipsis-left',
      49,
      50,
      51,
      'ellipsis-right',
      100,
    ])
  })

  // Clamping: current > total
  it('current=999, total=100 → clamps to 100 → [1, ellipsis-left, 98, 99, 100]', () => {
    expect(paginationWindow(999, 100)).toEqual([1, 'ellipsis-left', 98, 99, 100])
  })

  // Clamping: current < 1
  it('current=0, total=5 → clamps to 1 → [1, 2, 3, 4, 5]', () => {
    expect(paginationWindow(0, 5)).toEqual([1, 2, 3, 4, 5])
  })

  // Custom options
  it('current=5, total=20, siblings=2 boundaries=1 → [1, ellipsis-left, 3, 4, 5, 6, 7, ellipsis-right, 20]', () => {
    expect(paginationWindow(5, 20, { siblings: 2, boundaries: 1 })).toEqual([
      1,
      'ellipsis-left',
      3,
      4,
      5,
      6,
      7,
      'ellipsis-right',
      20,
    ])
  })
})
