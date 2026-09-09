import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, DEFAULT_ACCENT_HEX, DEFAULT_ACCENT_PRESET } from './accentPresets'

describe('accentPresets', () => {
  it('defaults to Sky', () => {
    expect(DEFAULT_ACCENT_PRESET).toBe('sky')
    expect(DEFAULT_ACCENT_HEX).toBe('#0ea5e9')
    expect(ACCENT_PRESETS.find((p) => p.id === DEFAULT_ACCENT_PRESET)?.hex).toBe(DEFAULT_ACCENT_HEX)
  })
})
