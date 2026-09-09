import { describe, expect, it } from 'vitest'
import { titlebarRowHeight } from './windowChrome'

describe('titlebarRowHeight', () => {
  it('keeps the compact SuperX row for signature and clean', () => {
    expect(titlebarRowHeight('signature')).toBe(36)
    expect(titlebarRowHeight('clean')).toBe(36)
  })

  it('gives clay a taller row for its pill tabs', () => {
    expect(titlebarRowHeight('clay')).toBe(44)
  })
})
