import { describe, it, expect } from 'vitest'
import { cloudGuidanceVariant } from './cloudGuidanceVariant'

describe('cloudGuidanceVariant', () => {
  it("maps 'gdrive' to 'google'", () => {
    expect(cloudGuidanceVariant('gdrive')).toBe('google')
  })

  it("maps 'icloud' to 'icloud'", () => {
    expect(cloudGuidanceVariant('icloud')).toBe('icloud')
  })

  it("maps 'local' to generic", () => {
    expect(cloudGuidanceVariant('local')).toBe('generic')
  })

  it('maps null to generic', () => {
    expect(cloudGuidanceVariant(null)).toBe('generic')
  })

  it('maps an unknown provider to generic', () => {
    expect(cloudGuidanceVariant('dropbox')).toBe('generic')
  })

  it("does NOT map 'google_drive' to 'google' (wrong provider id)", () => {
    // This is the bug that F4 fixed: the old code checked 'google_drive' which
    // is not the actual provider string — it should be 'gdrive'.
    expect(cloudGuidanceVariant('google_drive')).toBe('generic')
  })
})
