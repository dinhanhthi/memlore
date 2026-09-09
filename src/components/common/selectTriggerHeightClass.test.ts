import { describe, expect, it } from 'vitest'
import { selectTriggerHeightClass } from './Select'

describe('selectTriggerHeightClass', () => {
  it('pins the closed trigger to Button md height', () => {
    expect(selectTriggerHeightClass(false)).toBe('h-9')
  })

  it('keeps two-line description triggers from clipping', () => {
    expect(selectTriggerHeightClass(true)).toBe('min-h-9 py-2')
  })
})
