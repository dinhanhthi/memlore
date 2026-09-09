import { describe, expect, it } from 'vitest'
import { clampSubmenuVerticalPosition } from './submenuPosition'

describe('clampSubmenuVerticalPosition', () => {
  it('returns preferred margin when the pane already fits', () => {
    expect(
      clampSubmenuVerticalPosition({
        anchorTop: 24,
        paneHeight: 300,
        viewportHeight: 600,
        preferredMarginTop: 0,
      }),
    ).toBe(0)
  })

  it('slides the pane up when it would overflow the bottom edge', () => {
    expect(
      clampSubmenuVerticalPosition({
        anchorTop: 420,
        paneHeight: 300,
        viewportHeight: 600,
        preferredMarginTop: 0,
      }),
    ).toBe(-128)
  })

  it('slides the pane down when it would overflow the top edge', () => {
    expect(
      clampSubmenuVerticalPosition({
        anchorTop: 4,
        paneHeight: 300,
        viewportHeight: 600,
        preferredMarginTop: -20,
      }),
    ).toBe(4)
  })

  it('respects a row-aligned preferred offset when there is room', () => {
    expect(
      clampSubmenuVerticalPosition({
        anchorTop: 80,
        paneHeight: 200,
        viewportHeight: 600,
        preferredMarginTop: 120,
      }),
    ).toBe(120)
  })

  it('clamps a row-aligned preferred offset near the bottom edge', () => {
    expect(
      clampSubmenuVerticalPosition({
        anchorTop: 80,
        paneHeight: 200,
        viewportHeight: 600,
        preferredMarginTop: 420,
      }),
    ).toBe(312)
  })
})
