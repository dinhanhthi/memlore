// Accent color presets offered in appearance settings and onboarding.

import type { AccentPreset } from './themeColors'

export const DEFAULT_ACCENT_PRESET: AccentPreset = 'sky'
export const DEFAULT_ACCENT_HEX = '#0ea5e9'

export const ACCENT_PRESETS: { id: AccentPreset; hex: string }[] = [
  { id: 'orange', hex: '#fb923c' },
  { id: 'violet', hex: '#a78bfa' },
  { id: 'rose', hex: '#f43f5e' },
  { id: 'sky', hex: DEFAULT_ACCENT_HEX },
  { id: 'emerald', hex: '#10b981' },
  { id: 'gray', hex: '#737373' },
]
