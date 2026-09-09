import { describe, it, expect } from 'vitest'
import { truncateText } from './truncateText'

describe('truncateText', () => {
  it('returns the string unchanged when within max length', () => {
    expect(truncateText('Short title', 24)).toBe('Short title')
  })

  it('returns the string unchanged when exactly max length', () => {
    expect(truncateText('123456789012345678901234', 24)).toBe('123456789012345678901234')
  })

  it('truncates with an ellipsis when longer than max', () => {
    expect(truncateText('Một ngày mưa rất dài', 12)).toBe('Một ngày mư…')
  })

  it('trims surrounding whitespace before measuring', () => {
    expect(truncateText('  padded  ', 10)).toBe('padded')
  })
})
