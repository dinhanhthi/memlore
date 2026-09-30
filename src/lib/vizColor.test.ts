import { afterEach, describe, expect, it, vi } from 'vitest'
import { readVizColor } from './vizColor'

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--color-viz-1')
  document.documentElement.style.removeProperty('--color-viz-2')
})

describe('readVizColor', () => {
  it('returns the trimmed custom property from the document element', () => {
    document.documentElement.style.setProperty('--color-viz-1', '  oklch(0.54 0.11 75)  ')
    expect(readVizColor('--color-viz-1')).toBe('oklch(0.54 0.11 75)')
  })

  it('reads --color-viz-2 on its own', () => {
    document.documentElement.style.setProperty('--color-viz-2', 'oklch(0.7 0.12 292)')
    expect(readVizColor('--color-viz-2')).toBe('oklch(0.7 0.12 292)')
  })

  it('falls back to the token string when document is undefined', () => {
    vi.stubGlobal('document', undefined)
    expect(readVizColor('--color-viz-1')).toBe('var(--color-viz-1)')
    expect(readVizColor('--color-viz-2')).toBe('var(--color-viz-2)')
  })
})
