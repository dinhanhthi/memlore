import { describe, expect, it } from 'vitest'
import { dailyPromptIndex, nextPromptIndex, promptSeedHtml } from './dashboardPrompts'

describe('dailyPromptIndex', () => {
  it('returns 0 when count is 0 or negative', () => {
    expect(dailyPromptIndex('2026-04-14', 0)).toBe(0)
    expect(dailyPromptIndex('2026-04-14', -3)).toBe(0)
  })

  it('is deterministic for the same date key and count', () => {
    const a = dailyPromptIndex('2026-04-14', 30)
    const b = dailyPromptIndex('2026-04-14', 30)
    expect(a).toBe(b)
  })

  it('returns an index in [0, count)', () => {
    const count = 30
    const idx = dailyPromptIndex('2026-04-14', count)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThan(count)
  })

  it('distributes over at least 2 indices for different keys', () => {
    const count = 30
    const indices = new Set<number>()
    for (let day = 1; day <= 31; day++) {
      const key = `2026-01-${String(day).padStart(2, '0')}`
      indices.add(dailyPromptIndex(key, count))
    }
    expect(indices.size).toBeGreaterThanOrEqual(2)
  })
})

describe('nextPromptIndex', () => {
  it('returns 0 when count is 0 or 1', () => {
    expect(nextPromptIndex(0, 0)).toBe(0)
    expect(nextPromptIndex(0, 1)).toBe(0)
    expect(nextPromptIndex(4, 1)).toBe(0)
  })

  it('never equals current when count > 1', () => {
    const count = 10
    const current = 3
    for (let i = 0; i < 40; i++) {
      const next = nextPromptIndex(current, count, () => i / 40)
      expect(next).not.toBe(current)
      expect(next).toBeGreaterThanOrEqual(0)
      expect(next).toBeLessThan(count)
    }
  })

  it('still avoids current when random would land on current', () => {
    const count = 5
    const current = 0
    // Math.floor(0 * count) === 0 — a naive pick would return current.
    expect(nextPromptIndex(current, count, () => 0)).not.toBe(current)
  })
})

describe('promptSeedHtml', () => {
  it('escapes script tags via the DOM', () => {
    const html = promptSeedHtml('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
