import { describe, expect, it } from 'vitest'
import { PANEL_WIDTH, clampPanelPos, defaultPanelPos } from './clampPanelPos'

const viewport = { width: 1280, height: 800 }

describe('clampPanelPos', () => {
  it('clamps x when saved position is off the right edge', () => {
    expect(clampPanelPos({ x: 2000, y: 12 }, viewport)).toEqual({
      x: viewport.width - PANEL_WIDTH,
      y: 12,
    })
  })

  it('clamps y when saved position is below the viewport', () => {
    expect(clampPanelPos({ x: 12, y: 900 }, viewport)).toEqual({
      x: 12,
      y: viewport.height - 40,
    })
  })

  it('clamps negative coordinates to zero', () => {
    expect(clampPanelPos({ x: -40, y: -10 }, viewport)).toEqual({ x: 0, y: 0 })
  })
})

describe('defaultPanelPos', () => {
  it('places the panel in the top-right with padding', () => {
    expect(defaultPanelPos(viewport)).toEqual({
      x: viewport.width - PANEL_WIDTH - 12,
      y: 12,
    })
  })
})
