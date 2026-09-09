import { describe, expect, it } from 'vitest'
import {
  bumpSaveGeneration,
  isLatestSaveGeneration,
  isLatestSaveGenerationForEntry,
} from './saveGeneration'

describe('isLatestSaveGeneration', () => {
  it('accepts only the current in-flight generation', () => {
    expect(isLatestSaveGeneration(1, 1)).toBe(true)
    expect(isLatestSaveGeneration(1, 2)).toBe(false)
    expect(isLatestSaveGeneration(3, 3)).toBe(true)
  })
})

describe('per-entry save generation', () => {
  it('lets A stay latest when B bumps', () => {
    const byEntry: Record<string, number> = {}
    const genA = bumpSaveGeneration(byEntry, 'a')
    const genB = bumpSaveGeneration(byEntry, 'b')
    expect(isLatestSaveGenerationForEntry(byEntry, 'a', genA)).toBe(true)
    expect(isLatestSaveGenerationForEntry(byEntry, 'b', genB)).toBe(true)
    const genA2 = bumpSaveGeneration(byEntry, 'a')
    expect(isLatestSaveGenerationForEntry(byEntry, 'a', genA)).toBe(false)
    expect(isLatestSaveGenerationForEntry(byEntry, 'a', genA2)).toBe(true)
    expect(isLatestSaveGenerationForEntry(byEntry, 'b', genB)).toBe(true)
  })
})
