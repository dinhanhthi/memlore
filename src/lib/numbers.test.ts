import { describe, it, expect } from 'vitest'
import { formatCount } from './numbers'

describe('formatCount', () => {
  it('formats a small number without thousands separator', () => {
    expect(formatCount(42)).toBe('42')
  })

  it('formats a large number with en thousands separator (comma)', () => {
    expect(formatCount(1234, 'en')).toBe('1,234')
  })

  it('formats a large number with vi thousands separator (period)', () => {
    expect(formatCount(1234, 'vi')).toBe('1.234')
  })

  it('formats zero', () => {
    expect(formatCount(0)).toBe('0')
  })
})
