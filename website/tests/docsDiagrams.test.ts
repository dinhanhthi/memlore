import { describe, expect, it } from 'vitest'
import { aiDiagram } from '../src/docs/diagrams/ai'
import { DIAGRAMS } from '../src/docs/diagrams'
import { encryptionDiagram } from '../src/docs/diagrams/encryption'
import { locksDiagram } from '../src/docs/diagrams/locks'
import { privacyDiagram } from '../src/docs/diagrams/privacy'
import { syncDiagram } from '../src/docs/diagrams/sync'
import type { DiagramName } from '../src/docs/manifest'

const NAMES = [
  'privacy',
  'encryption',
  'locks',
  'sync',
  'ai',
] as const satisfies readonly DiagramName[]

const TITLES: Record<DiagramName, string> = {
  privacy: 'Privacy',
  encryption: 'Encryption',
  locks: 'Locks',
  sync: 'Sync',
  ai: 'AI',
}

// Paint attributes only, so a marker reference such as url(#arrow-end) is not a colour.
const HEX_IN_PAINT =
  /(?:\bfill|\bstroke|\bstop-color|\bstyle)\s*=\s*(?:"[^"]*#(?:[0-9a-fA-F]{3,8})\b|'[^']*#(?:[0-9a-fA-F]{3,8})\b)/

describe('DIAGRAMS', () => {
  it('has the five diagram keys', () => {
    expect(Object.keys(DIAGRAMS).sort()).toEqual([...NAMES].sort())
  })

  it('assembles each diagram from its own module', () => {
    expect(privacyDiagram).toBe(DIAGRAMS.privacy)
    expect(encryptionDiagram).toBe(DIAGRAMS.encryption)
    expect(locksDiagram).toBe(DIAGRAMS.locks)
    expect(syncDiagram).toBe(DIAGRAMS.sync)
    expect(aiDiagram).toBe(DIAGRAMS.ai)
  })

  it('rejects hex paint and still allows a word marker url', () => {
    expect(HEX_IN_PAINT.test('fill="#fff"')).toBe(true)
    expect(HEX_IN_PAINT.test('stroke="#abc"')).toBe(true)
    expect(HEX_IN_PAINT.test('stop-color="#112233"')).toBe(true)
    expect(HEX_IN_PAINT.test('style="fill:#fff"')).toBe(true)
    expect(HEX_IN_PAINT.test('marker-end="url(#arrow-end)"')).toBe(false)
    expect(HEX_IN_PAINT.test('fill="url(#arrow-end)"')).toBe(false)
  })

  it('keeps every svg presentational and unsized', () => {
    for (const name of NAMES) {
      const svg = DIAGRAMS[name]
      expect(svg, name).toContain('role="img"')
      expect(svg, name).toContain(`<title>${TITLES[name]}</title>`)
      expect(svg, name).not.toContain('<script')
      expect(svg, name).not.toMatch(/on[a-z]+=/)
      expect(svg, name).not.toMatch(/href=/)
      expect(svg, name).not.toMatch(HEX_IN_PAINT)

      const root = /^<svg\b[^>]*>/.exec(svg)?.[0]
      expect(root, name).toBeTruthy()
      expect(root, name).toMatch(/\bviewBox="/)
      expect(root, name).not.toMatch(/\swidth="/)
      expect(root, name).not.toMatch(/\sheight="/)
    }
  })
})
