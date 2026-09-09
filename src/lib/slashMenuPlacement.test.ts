import { describe, expect, it } from 'vitest'
import { placeSlashMenu } from './slashMenuPlacement'

const VIEWPORT = { width: 800, height: 800 }

describe('placeSlashMenu', () => {
  it('places the menu below the caret when there is more room below', () => {
    const placed = placeSlashMenu({
      caret: { top: 80, bottom: 100, left: 40 },
      viewport: VIEWPORT,
    })
    expect(placed.placement).toBe('below')
    expect(placed.top).toBe(106)
    expect(placed.bottom).toBeNull()
    expect(placed.left).toBe(40)
    expect(placed.maxHeight).toBe(280)
  })

  it('caps maxHeight to the space left under the caret', () => {
    const placed = placeSlashMenu({
      caret: { top: 100, bottom: 560, left: 16 },
      viewport: VIEWPORT,
    })
    expect(placed.placement).toBe('below')
    expect(placed.maxHeight).toBe(800 - 560 - 6)
  })

  it('flips above the caret when more room is above, so the last rows stay on screen', () => {
    const placed = placeSlashMenu({
      caret: { top: 700, bottom: 720, left: 16 },
      viewport: VIEWPORT,
    })
    expect(placed.placement).toBe('above')
    expect(placed.top).toBeNull()
    expect(placed.bottom).toBe(800 - 700 + 6)
    expect(placed.maxHeight).toBe(280)
  })

  it('caps maxHeight to the space above when flipping', () => {
    const placed = placeSlashMenu({
      caret: { top: 120, bottom: 700, left: 16 },
      viewport: VIEWPORT,
    })
    expect(placed.placement).toBe('above')
    expect(placed.maxHeight).toBe(120 - 6)
  })
})
