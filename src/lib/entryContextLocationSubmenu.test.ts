import { describe, expect, it } from 'vitest'
import { LOCATION_SUBMENU_PANE_CLASS } from './entryContextLocationSubmenu'

describe('entry context location submenu layout', () => {
  const tokens = LOCATION_SUBMENU_PANE_CLASS.split(/\s+/).filter(Boolean)

  it('puts overflow-y-auto on the pane itself', () => {
    expect(tokens).toContain('overflow-y-auto')
  })

  it('does not use an auto-height flex column that needs a nested scroller', () => {
    expect(tokens).not.toContain('flex')
    expect(tokens).not.toContain('flex-col')
    expect(tokens).not.toContain('flex-1')
    expect(tokens).not.toContain('min-h-0')
  })
})
