import { describe, expect, it } from 'vitest'
import en from './en/nav.json'
import vi from './vi/nav.json'
import { keyPaths } from './keyParity'

// See `keyParity.ts` for why this test exists and how plural suffixes are
// handled.
describe('nav.json en/vi key parity', () => {
  const enKeys = keyPaths(en)
  const viKeys = keyPaths(vi)

  it('has at least one key to compare', () => {
    expect(enKeys.size).toBeGreaterThan(0)
  })

  it('vi has no keys missing from en', () => {
    const missing = [...viKeys].filter((k) => !enKeys.has(k))
    expect(missing).toEqual([])
  })

  it('en has no keys missing from vi', () => {
    const missing = [...enKeys].filter((k) => !viKeys.has(k))
    expect(missing).toEqual([])
  })
})
