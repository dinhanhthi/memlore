import { describe, expect, it, vi } from 'vitest'

// Web build: Dashboard and Statistics are out of scope (docs/LATER.md), so the palette must not
// offer them.
vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return {
    ...actual,
    isWeb: true,
    capabilities: { ...actual.capabilities, dashboard: false, stats: false },
  }
})

import { getCommands } from './registry'

describe('command palette on web', () => {
  it('does not offer the Dashboard or Statistics pages', () => {
    const available = getCommands()
      .filter((c) => c.available?.() ?? true)
      .map((c) => c.id)
    expect(available).not.toContain('page.dashboard')
    expect(available).not.toContain('page.stats')
    expect(available).toContain('page.entries')
  })
})
