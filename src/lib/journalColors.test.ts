import { describe, expect, it } from 'vitest'
import {
  PRESET_COLORS,
  getRandomJournalColor,
  resolveOnboardingJournalColor,
} from './journalColors'

describe('getRandomJournalColor', () => {
  it('selects a color from the journal palette using the supplied random value', () => {
    expect(getRandomJournalColor(() => 0)).toBe(PRESET_COLORS[0].hex)
    expect(getRandomJournalColor(() => 0.999999)).toBe(PRESET_COLORS.at(-1)?.hex)
  })
})

describe('resolveOnboardingJournalColor', () => {
  it('replaces the seeded color with the first-run random color', () => {
    expect(resolveOnboardingJournalColor(true, '#4F46E5', '#DB2777')).toBe('#DB2777')
  })

  it('preserves the color of an existing journal', () => {
    expect(resolveOnboardingJournalColor(false, '#4F46E5', '#DB2777')).toBe('#4F46E5')
  })
})
