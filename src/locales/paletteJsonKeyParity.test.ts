import { describe, expect, it } from 'vitest'
import en from './en/palette.json'
import vi from './vi/palette.json'

/**
 * Same guard as `aiJsonKeyParity.test.ts`, for the command-palette bundle:
 * `palette.json` is edited by hand on both locales whenever a command is
 * added or removed (e.g. the AI settings redesign's `settings.ai_danger`
 * deletion). A one-sided edit ships a missing string silently — i18next
 * just falls back to the raw key at runtime, with no build error.
 */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

function stripPluralSuffix(segment: string): string {
  const suffix = PLURAL_SUFFIXES.find((s) => segment.endsWith(s))
  return suffix ? segment.slice(0, -suffix.length) : segment
}

function collectKeyPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (typeof value !== 'object' || value === null) {
    out.add(prefix)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const segment = stripPluralSuffix(key)
    collectKeyPaths(child, prefix ? `${prefix}.${segment}` : segment, out)
  }
}

function keyPaths(bundle: object): Set<string> {
  const out = new Set<string>()
  collectKeyPaths(bundle, '', out)
  return out
}

describe('palette.json en/vi key parity', () => {
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
