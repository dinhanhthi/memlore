import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyDesignSystem } from './designSystem'
import {
  applyAccent,
  applyFont,
  applyFontContrast,
  applyFontSize,
  applySurfaceStyle,
  clampFontContrast,
  clampFontSize,
  defaultFontSizeFor,
  getChartAccentColors,
  HEATMAP_EMPTY_CELL,
  FONT_CONTRAST_DEFAULT,
  FONT_CONTRAST_MAX,
  FONT_CONTRAST_MIN,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  getContrastRatio,
  getPresetHex,
  isValidHex,
  loadCustomGoogleFont,
  setGradientEnabled,
  unloadCustomGoogleFont,
  type AccentPreset,
  type FontFamily,
  CLAY_ACCENTS,
} from './themeColors'

describe('getContrastRatio', () => {
  it('returns 21 for black on white', () => {
    const ratio = getContrastRatio('#000000', '#FFFFFF')
    expect(ratio).toBeCloseTo(21, 0)
  })

  it('returns 1 for same color', () => {
    const ratio = getContrastRatio('#FF0000', '#FF0000')
    expect(ratio).toBeCloseTo(1, 1)
  })

  it('is commutative', () => {
    const a = getContrastRatio('#3D5AFE', '#FFFFFF')
    const b = getContrastRatio('#FFFFFF', '#3D5AFE')
    expect(a).toBeCloseTo(b, 5)
  })
})

describe('isValidHex', () => {
  it('accepts valid 6-digit hex', () => {
    expect(isValidHex('#8b5cf6')).toBe(true)
    expect(isValidHex('#FF0066')).toBe(true)
    expect(isValidHex('#000000')).toBe(true)
  })

  it('rejects invalid hex', () => {
    expect(isValidHex('8b5cf6')).toBe(false)
    expect(isValidHex('#fff')).toBe(false)
    expect(isValidHex('#gggggg')).toBe(false)
    expect(isValidHex('')).toBe(false)
  })
})

describe('getPresetHex', () => {
  it('returns correct hex for known presets', () => {
    expect(getPresetHex('orange')).toBe('#fb923c')
    expect(getPresetHex('violet')).toBe('#a78bfa')
    expect(getPresetHex('rose')).toBe('#f43f5e')
    expect(getPresetHex('sky')).toBe('#0ea5e9')
  })

  it('returns the sky default as fallback for custom', () => {
    expect(getPresetHex('custom')).toBe('#0ea5e9')
  })

  it('falls back to the sky default for a removed/unknown preset id', () => {
    // A persisted 'amber' (removed from the union) cast from storage without
    // validation must not throw — it falls back to the default brand accent,
    // mirroring applyAccent / resolveHue / getChartAccentColors.
    expect(getPresetHex('amber' as AccentPreset)).toBe('#0ea5e9')
  })
})

describe('applyAccent', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove('dark')
  })

  it('sets SuperX hex accent for orange preset (default brand)', () => {
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#fb923c')
    expect(document.documentElement.style.getPropertyValue('--color-accent-hover')).toBe('#fdba74')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('41')
  })

  it('falls back to the sky default for a removed preset id (legacy persisted value)', () => {
    // A persisted 'amber' from an earlier build is read from storage and cast
    // to AccentPreset without validation; applyAccent must fall back to sky
    // rather than throw or write undefined tokens.
    applyAccent('amber' as AccentPreset, null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('230')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('230')
  })

  it('mixes orange soft accent into the surface (not a pure wash)', () => {
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent-soft')).toContain(
      'color-mix',
    )
    document.documentElement.classList.add('dark')
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent-soft')).toContain(
      '#1c1c1c',
    )
  })

  it('sets --color-accent for violet preset', () => {
    applyAccent('violet', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('280')
  })

  it('sets --color-accent for rose preset', () => {
    applyAccent('rose', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('350')
  })

  it('retunes --surface-hue to the accent hue so decor tracks the theme', () => {
    applyAccent('sky', null)
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('230')
    applyAccent('emerald', null)
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('160')
  })

  it('sets --color-accent for custom hex', () => {
    applyAccent('custom', '#FF0066')
    const accent = document.documentElement.style.getPropertyValue('--color-accent')
    expect(accent).toBeTruthy()
    expect(accent).not.toContain('280')
  })

  it('retunes --surface-hue for a custom hex and falls back on a bad hex', () => {
    applyAccent('custom', '#FF0066')
    const hue = document.documentElement.style.getPropertyValue('--surface-hue')
    expect(hue).toBeTruthy()
    expect(hue).not.toBe('NaN')
    // Malformed hex → hexToHue returns NaN → defensive fallback to sky hue 230.
    applyAccent('custom', 'not-a-hex')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('230')
  })

  it('uses different lightness for dark mode (oklch presets)', () => {
    document.documentElement.classList.add('dark')
    applyAccent('violet', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('72%')
  })

  it('uses light mode lightness by default (oklch presets)', () => {
    applyAccent('violet', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toContain('55%')
  })

  // Mix-with-black collapses chroma (orange reads brown). CTA fills are a
  // chroma-preserving oklch in BOTH modes, at the lightest L that still
  // clears 4.5:1 with white. applyAccent uses the same per-preset stops.
  const CTA_FILLS: Record<string, string> = {
    orange: 'oklch(56% 0.2 50)',
    violet: 'oklch(56% 0.2 280)',
    rose: 'oklch(57% 0.2 350)',
    sky: 'oklch(53% 0.2 230)',
    emerald: 'oklch(52% 0.2 160)',
    gray: 'oklch(52% 0 286)',
  }

  it('writes a chroma-preserving accent-fill per preset in light mode', () => {
    for (const [preset, fill] of Object.entries(CTA_FILLS)) {
      applyAccent(preset as 'violet', null)
      expect(document.documentElement.style.getPropertyValue('--color-accent-fill')).toBe(fill)
    }
  })

  it('writes the same chroma-preserving accent-fill per preset in dark mode', () => {
    document.documentElement.classList.add('dark')
    for (const [preset, fill] of Object.entries(CTA_FILLS)) {
      applyAccent(preset as 'violet', null)
      expect(document.documentElement.style.getPropertyValue('--color-accent-fill')).toBe(fill)
    }
  })

  it('paints --grad-accent-fill as a two-stop oklch sweep in dark mode', () => {
    document.documentElement.classList.add('dark')
    applyAccent('sky', null)
    expect(document.documentElement.style.getPropertyValue('--grad-accent-fill')).toBe(
      'linear-gradient(165deg, oklch(46% 0.2 230), oklch(53% 0.2 230))',
    )
  })

  it('paints --grad-accent-fill as a two-stop oklch sweep in light mode', () => {
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--grad-accent-fill')).toBe(
      'linear-gradient(165deg, oklch(49% 0.2 50), oklch(56% 0.2 50))',
    )
  })

  it('pins --grad-accent-fill to the solid fill when gradients are disabled', () => {
    setGradientEnabled(false)
    applyAccent('sky', null)
    expect(document.documentElement.style.getPropertyValue('--grad-accent-fill')).toBe(
      'oklch(53% 0.2 230)',
    )
    setGradientEnabled(true)
  })

  it('uses a conservative high-chroma fill for custom hex in light and dark', () => {
    applyAccent('custom', '#FF0066')
    const light = document.documentElement.style.getPropertyValue('--color-accent-fill')
    expect(light).toMatch(/^oklch\(52% 0\.2 /)
    expect(light).not.toContain('#000')
    document.documentElement.classList.add('dark')
    applyAccent('custom', '#FF0066')
    const dark = document.documentElement.style.getPropertyValue('--color-accent-fill')
    expect(dark).toBe(light)
  })

  afterEach(() => {
    // Guard: the gradient-disabled test flips global state — a mid-test throw
    // must not leave gradients off for every subsequent test in the file.
    setGradientEnabled(true)
  })

  // Locks the art-directed --grad-primary stops (decorative borders / glows).
  // CTA button fills use --color-accent-fill, not these stops.
  it('applies the hand-tuned dark-mode CTA gradient per chromatic preset', () => {
    document.documentElement.classList.add('dark')
    const expected: Record<string, string> = {
      orange: 'linear-gradient(135deg, #f97316, #fb923c)',
      violet: 'linear-gradient(135deg, oklch(0.57 0.27 291.07), oklch(0.51 0.19 281.25))',
      rose: 'linear-gradient(135deg, oklch(0.75 0.23 346.83), oklch(0.6 0.21 347.23))',
      sky: 'linear-gradient(135deg, oklch(0.71 0.17 250.98), oklch(0.59 0.14 237.86))',
      emerald: 'linear-gradient(135deg, oklch(0.71 0.2 151.18), oklch(0.57 0.18 157.21))',
    }
    for (const [preset, grad] of Object.entries(expected)) {
      applyAccent(preset as 'violet', null)
      expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe(grad)
    }
  })

  // Light-mode counterpart. Orange = SuperX solid gradient both modes.
  it('applies the hand-tuned light-mode CTA gradient per chromatic preset', () => {
    const expected: Record<string, string> = {
      orange: 'linear-gradient(135deg, #f97316, #fb923c)',
      violet: 'linear-gradient(135deg, oklch(0.66 0.2 289.6), oklch(0.58 0.16 283.36))',
      rose: 'linear-gradient(135deg, oklch(0.76 0.23 345.18), oklch(0.65 0.21 348.87))',
      sky: 'linear-gradient(135deg, oklch(0.8 0.14 226.02), oklch(0.64 0.16 234.21))',
      emerald: 'linear-gradient(135deg, oklch(0.77 0.23 160.1), oklch(0.64 0.17 161.62))',
    }
    for (const [preset, grad] of Object.entries(expected)) {
      applyAccent(preset as 'violet', null)
      expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe(grad)
    }
  })

  it('keeps the generic AA-safe dark solid fill when gradients are disabled', () => {
    document.documentElement.classList.add('dark')
    setGradientEnabled(false)
    applyAccent('emerald', null)
    // solidPrimary stays the generic L49% solid, not the gradient's light first stop.
    expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe(
      'oklch(49% 0.27 160)',
    )
    setGradientEnabled(true)
  })

  it('pins SuperX solid when gradients are disabled for orange', () => {
    document.documentElement.classList.add('dark')
    setGradientEnabled(false)
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe('#fb923c')
    setGradientEnabled(true)
  })
})

// Clean vs Signature paint contract (Phase 2 Tasks 2–4). Inline glow/gradient
// cannot be overridden by CSS — these assertions lock the applier so a later
// refactor of themeColors.ts cannot silently reintroduce gradients in Clean.
describe('applyAccent — Clean vs Signature paint', () => {
  const NAMED_PRESETS: Exclude<AccentPreset, 'custom'>[] = [
    'orange',
    'violet',
    'rose',
    'sky',
    'emerald',
    'gray',
  ]
  const ALL_PRESETS: AccentPreset[] = [...NAMED_PRESETS, 'custom']
  const CUSTOM_HEX = '#FF0066'

  function paint(preset: AccentPreset): void {
    applyAccent(preset, preset === 'custom' ? CUSTOM_HEX : null)
  }

  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    setGradientEnabled(true)
  })

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.classList.remove(
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
  })

  it('emits a flat fill and no glow under Clean', () => {
    applyDesignSystem('clean')
    applyAccent('orange', null)
    const root = document.documentElement
    const glow = root.style.getPropertyValue('--shadow-primary-glow').trim()
    const grad = root.style.getPropertyValue('--grad-primary')
    expect(glow).toBe('none')
    expect(grad).not.toContain('gradient')
    expect(root.style.getPropertyValue('--grad-accent-fill')).not.toContain('gradient')
    expect(root.style.getPropertyValue('--grad-accent-fill')).toBe(
      root.style.getPropertyValue('--color-accent-fill'),
    )
    expect(getComputedStyle(root).getPropertyValue('--shadow-primary-glow').trim()).toBe('none')
    expect(getComputedStyle(root).getPropertyValue('--grad-primary')).not.toContain('gradient')
  })

  it('keeps the Signature orange glow and linear-gradient', () => {
    applyDesignSystem('signature')
    applyAccent('orange', null)
    const root = document.documentElement
    const spikeGlow = '0 0 0 1px rgb(251 146 60 / 0.3), 0 8px 20px rgb(251 146 60 / 0.2)'
    expect(root.style.getPropertyValue('--shadow-primary-glow')).toBe(spikeGlow)
    expect(root.style.getPropertyValue('--grad-primary')).toContain('linear-gradient')
    expect(root.style.getPropertyValue('--grad-accent-fill')).toBe(
      'linear-gradient(165deg, oklch(49% 0.2 50), oklch(56% 0.2 50))',
    )
    expect(getComputedStyle(root).getPropertyValue('--shadow-primary-glow').trim()).toBe(spikeGlow)
    expect(getComputedStyle(root).getPropertyValue('--grad-primary')).toContain('linear-gradient')
  })

  it('writes the chroma-preserving CTA sweep under Signature in dark mode', () => {
    applyDesignSystem('signature')
    document.documentElement.classList.add('dark')
    applyAccent('sky', null)
    const root = document.documentElement
    expect(root.style.getPropertyValue('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
    expect(root.style.getPropertyValue('--grad-accent-fill')).toBe(
      'linear-gradient(165deg, oklch(46% 0.2 230), oklch(53% 0.2 230))',
    )
  })

  it('Clean --grad-primary is flat for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-primary')).not.toContain('gradient')
    }
  })

  it('Clean --shadow-primary-glow is none for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--shadow-primary-glow').trim()).toBe('none')
    }
  })

  it('Clean --surface-chroma-scale is 0 for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--surface-chroma-scale')).toBe('0')
    }
  })

  it('Clean --grad-accent-soft is flat for every preset', () => {
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-accent-soft')).not.toContain('gradient')
    }
  })

  it('Signature --grad-primary is linear-gradient for every preset', () => {
    applyDesignSystem('signature')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-primary')).toContain('linear-gradient')
    }
  })

  it('Signature --grad-primary is a solid fill when gradients are disabled', () => {
    applyDesignSystem('signature')
    setGradientEnabled(false)
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      expect(root.style.getPropertyValue('--grad-primary')).not.toContain('gradient')
    }
  })

  // Orange's glow is rgb(); oklch presets (including gray) use oklch() halos.
  // Assert the actual Signature contract — do not force /rgb(/ on gray.
  it('Signature --shadow-primary-glow is a glow for every preset', () => {
    applyDesignSystem('signature')
    const root = document.documentElement
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const glow = root.style.getPropertyValue('--shadow-primary-glow').trim()
      expect(glow).not.toBe('none')
      expect(glow).toMatch(/rgb\(|oklch\(/)
    }
  })

  it('Clean stays flat when the gradient toggle is on (orange and chromatic)', () => {
    setGradientEnabled(true)
    applyDesignSystem('clean')
    const root = document.documentElement
    for (const preset of ['orange', 'violet'] as const) {
      applyAccent(preset, null)
      expect(root.style.getPropertyValue('--grad-primary')).not.toContain('gradient')
      expect(root.style.getPropertyValue('--shadow-primary-glow').trim()).toBe('none')
    }
  })

  it('applySurfaceStyle soft under Clean leaves surface-soft off', () => {
    document.documentElement.classList.add('surface-soft')
    applyDesignSystem('clean')
    applySurfaceStyle('soft')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('applySurfaceStyle lumen under Clean leaves both surface classes off', () => {
    document.documentElement.classList.add('surface-soft', 'surface-lumen')
    applyDesignSystem('clean')
    applySurfaceStyle('lumen')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('applySurfaceStyle lumen under Signature turns surface-lumen on and surface-soft off', () => {
    applyDesignSystem('signature')
    document.documentElement.classList.add('surface-soft')
    applySurfaceStyle('lumen')
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
  })

  it('applySurfaceStyle soft under Signature turns surface-soft on', () => {
    applyDesignSystem('signature')
    applySurfaceStyle('soft')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('applySurfaceStyle soft under Signature strips leftover surface-lumen', () => {
    applyDesignSystem('signature')
    document.documentElement.classList.add('surface-lumen')
    applySurfaceStyle('soft')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('malformed custom hex under Clean falls back to hue 230 with no glow', () => {
    applyDesignSystem('clean')
    applyAccent('custom', 'not-a-hex')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--surface-hue')).toBe('230')
    expect(root.style.getPropertyValue('--shadow-primary-glow').trim()).toBe('none')
    const accent = root.style.getPropertyValue('--color-accent')
    expect(accent).not.toBe('NaN')
    expect(accent).not.toContain('NaN')
  })
})

// Lumen pins Night Foundry brass in applyAccent and keeps Signature-style
// glows. Inline tokens beat CSS, so the pin must run the generic chromatic
// path (not orange fixed-hex, not Clean flatten) regardless of the persisted
// preset.
describe('applyAccent — Lumen honors the user preset', () => {
  const CUSTOM_HEX = '#FF0066'

  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    document.documentElement.classList.add('dark')
    applyDesignSystem('signature')
    document.documentElement.classList.add('surface-lumen')
    setGradientEnabled(true)
  })

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
  })

  function expectGlowsKept(): void {
    const root = document.documentElement
    expect(root.style.getPropertyValue('--shadow-primary-glow').trim()).not.toBe('none')
    expect(root.style.getPropertyValue('--grad-primary')).toContain('gradient')
  }

  it('applies sky (not brass) and does not flatten glows', () => {
    applyAccent('sky', null)
    const root = document.documentElement
    expect(root.style.getPropertyValue('--surface-hue')).toBe('230')
    expect(root.style.getPropertyValue('--color-accent')).toContain('230')
    expect(root.style.getPropertyValue('--surface-chroma-scale')).not.toBe('0')
    expectGlowsKept()
  })

  it('applies custom hex (not brass) and does not flatten glows', () => {
    applyAccent('custom', CUSTOM_HEX)
    const accent = document.documentElement.style.getPropertyValue('--color-accent')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).not.toBe('50')
    expect(accent).not.toContain(' 50)')
    expectGlowsKept()
  })

  it('applies SuperX orange fixed-hex and does not flatten glows', () => {
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#fb923c')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('41')
    expectGlowsKept()
  })
})

// Clay accent tokens are written inline by applyAccent — globals.test.ts
// cannot see them. These computed-contrast checks are the AA net for the
// Clay Press accent sheet (docs/design/DESIGN_clay.md §4).
describe('applyAccent — Clay computed contrast', () => {
  const NAMED_PRESETS: Exclude<AccentPreset, 'custom'>[] = [
    'orange',
    'violet',
    'rose',
    'sky',
    'emerald',
    'gray',
  ]
  const ALL_PRESETS: AccentPreset[] = [...NAMED_PRESETS, 'custom']
  const CUSTOM_HEX = '#FF0066'
  /** canvas, canvas-soft */
  const CLAY_LIGHT_PAPERS = ['#ebe3d6', '#f7f1e6']
  /** canvas, canvas-soft, neu */
  const CLAY_DARK_PAPERS = ['#171513', '#201d1a', '#2c2926']

  function paint(preset: AccentPreset): void {
    applyAccent(preset, preset === 'custom' ? CUSTOM_HEX : null)
  }

  function readVar(name: string): string {
    return document.documentElement.style.getPropertyValue(name)
  }

  // OKLCH → #rrggbb so getContrastRatio (hex-only) can score the built tokens.
  // Matrices from Björn Ottosson / CSS Color 4 (same as globals.test.ts).
  function oklchToHex(value: string): string {
    const match = value.trim().match(/^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)/i)
    if (!match || match[1] === undefined || match[3] === undefined || match[4] === undefined) {
      throw new Error(`not an oklch() value: ${value}`)
    }
    const L = match[2] === '%' ? Number(match[1]) / 100 : Number(match[1])
    const C = Number(match[3])
    const H = Number(match[4])
    const hue = (H * Math.PI) / 180
    const a = C * Math.cos(hue)
    const b = C * Math.sin(hue)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.291485548 * b
    const l = l_ * l_ * l_
    const m = m_ * m_ * m_
    const s = s_ * s_ * s_
    const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    const toSrgb = (c: number) => {
      const clamped = Math.min(1, Math.max(0, c))
      return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
    }
    const hex = (c: number) =>
      Math.round(toSrgb(c) * 255)
        .toString(16)
        .padStart(2, '0')
    return `#${hex(lr)}${hex(lg)}${hex(lb)}`
  }

  /** Kit presets are hex; a custom preset is derived oklch. */
  function toHex(value: string): string {
    return value.startsWith('#') ? value : oklchToHex(value)
  }

  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-clay',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    setGradientEnabled(true)
  })

  afterEach(() => {
    setGradientEnabled(true)
    document.documentElement.classList.remove(
      'dark',
      'ds-clean',
      'ds-signature',
      'ds-clay',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
  })

  it('oklchToHex + getContrastRatio sees black/white as 21:1', () => {
    expect(getContrastRatio(oklchToHex('oklch(0 0 0)'), oklchToHex('oklch(1 0 0)'))).toBeCloseTo(
      21,
      0,
    )
  })

  it('keeps clay accentText ≥ 4.5:1 on canvas and canvas-soft in light for every preset', () => {
    applyDesignSystem('clay')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const text = toHex(readVar('--color-accent-text'))
      for (const paper of CLAY_LIGHT_PAPERS) {
        expect(getContrastRatio(text, paper), `${preset} on ${paper}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps clay accentText ≥ 4.5:1 on canvas, canvas-soft and neu in dark for every preset', () => {
    applyDesignSystem('clay')
    document.documentElement.classList.add('dark')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const text = toHex(readVar('--color-accent-text'))
      for (const paper of CLAY_DARK_PAPERS) {
        expect(getContrastRatio(text, paper), `${preset} on ${paper}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the dark accent ink ≥ 4.5:1 on --color-accent-fill for every preset', () => {
    applyDesignSystem('clay')
    document.documentElement.classList.add('dark')
    for (const preset of ALL_PRESETS) {
      paint(preset)
      const ink = toHex(readVar('--color-accent-ink'))
      const fill = toHex(readVar('--color-accent-fill'))
      expect(getContrastRatio(ink, fill), preset).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('paints --grad-accent-fill as the kit slab: white top sheen over the flat fill', () => {
    applyDesignSystem('clay')
    paint('sky')
    expect(readVar('--grad-accent-fill')).toBe(
      'linear-gradient(180deg, rgb(255 255 255 / 0.22), transparent 46%), #4fa3c4',
    )
    expect(readVar('--color-accent-fill')).toBe('#4fa3c4')
  })

  it('pins Clay --grad-accent-fill to the flat fill when gradients are disabled', () => {
    applyDesignSystem('clay')
    setGradientEnabled(false)
    paint('sky')
    expect(readVar('--grad-accent-fill')).toBe('#4fa3c4')
  })

  it('reads every named preset from the kit sheet — SuperX orange is no exception', () => {
    applyDesignSystem('signature')
    paint('orange')
    expect(readVar('--color-accent')).toBe('#fb923c')
    applyDesignSystem('clay')
    paint('orange')
    expect(readVar('--color-accent')).toBe('#e28a45')
    expect(readVar('--color-accent-deep')).toBe('#c46d2c')
    expect(readVar('--color-accent-wash')).toBe('#f6e4d2')
    expect(readVar('--color-accent-soft')).toBe('rgb(226 138 69 / 0.14)')
    document.documentElement.classList.add('dark')
    paint('orange')
    expect(readVar('--color-accent')).toBe('#e39a5c')
    expect(readVar('--color-accent-text')).toBe('#e39a5c')
  })

  it('paints every named preset from the kit sheet in both modes', () => {
    applyDesignSystem('clay')
    for (const mode of ['light', 'dark'] as const) {
      document.documentElement.classList.toggle('dark', mode === 'dark')
      for (const preset of NAMED_PRESETS) {
        paint(preset)
        const sheet = CLAY_ACCENTS[preset][mode]
        expect(readVar('--color-accent'), `${mode}/${preset}`).toBe(sheet.acc)
        expect(readVar('--color-accent-fill'), `${mode}/${preset}`).toBe(sheet.acc)
        expect(readVar('--color-accent-deep'), `${mode}/${preset}`).toBe(sheet.deep)
        expect(readVar('--color-accent-wash'), `${mode}/${preset}`).toBe(sheet.wash)
        expect(readVar('--color-accent-ink'), `${mode}/${preset}`).toBe(
          mode === 'dark' ? sheet.ink : 'var(--color-fg-inverse)',
        )
        expect(readVar('--color-accent-soft'), `${mode}/${preset}`).toBe(sheet.ghost)
        expect(readVar('--color-accent-text'), `${mode}/${preset}`).toBe(sheet.text)
      }
    }
  })

  it('falls back to the sky sheet for a stale preset id under Clay', () => {
    applyDesignSystem('clay')
    applyAccent('amber' as AccentPreset, null)
    expect(readVar('--color-accent')).toBe(CLAY_ACCENTS.sky.light.acc)
  })

  it('derives a custom hex under Clay from its hue in the kit shape', () => {
    applyDesignSystem('clay')
    paint('custom')
    expect(readVar('--color-accent')).toMatch(/^oklch\(62% 0\.11 \d+\)$/)
    expect(readVar('--color-accent-deep')).toMatch(/^oklch\(52% 0\.11 /)
    document.documentElement.classList.add('dark')
    paint('custom')
    expect(readVar('--color-accent')).toMatch(/^oklch\(72% 0\.11 /)
  })

  it('keeps the Clay slab tokens inert under Signature', () => {
    applyDesignSystem('signature')
    paint('sky')
    expect(readVar('--color-accent-deep')).toBe(readVar('--color-accent-hover'))
    expect(readVar('--color-accent-wash')).toBe(readVar('--color-accent-soft'))
  })
})

describe('HEATMAP_EMPTY_CELL', () => {
  it('bakes Lumen empty-cell as sRGB of surface-hi oklch(26% 0.02 263)', () => {
    expect(HEATMAP_EMPTY_CELL.lumen).toBe('#1f242e')
  })
})

describe('gray (grayscale) preset', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove('dark')
    setGradientEnabled(true)
  })

  // Parse the leading lightness percentage out of an `oklch(L% C H)` string.
  function oklchLightness(s: string): number {
    const m = s.match(/oklch\(\s*([\d.]+)%/)
    if (!m) throw new Error(`not an oklch() value: ${s}`)
    return Number(m[1]) / 100
  }

  // White-on-color contrast for an ACHROMATIC color (chroma 0): relative
  // luminance is exactly Y = L³, so contrast = 1.05 / (L³ + 0.05).
  function whiteContrastForGray(l: number): number {
    return 1.05 / (Math.pow(l, 3) + 0.05)
  }

  // WCAG contrast between two ACHROMATIC oklch lightnesses (Y = L³ each).
  function grayContrast(l1: number, l2: number): number {
    const y1 = Math.pow(l1, 3)
    const y2 = Math.pow(l2, 3)
    return (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05)
  }

  it('exposes a neutral swatch hex via getPresetHex', () => {
    expect(getPresetHex('gray')).toBe('#737373')
  })

  it('renders every accent token at chroma 0 (light)', () => {
    applyAccent('gray', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      'oklch(45% 0 286)',
    )
    expect(document.documentElement.style.getPropertyValue('--color-accent-soft')).toBe(
      'oklch(60% 0 286 / 0.08)',
    )
  })

  it('renders every accent token at chroma 0 (dark)', () => {
    document.documentElement.classList.add('dark')
    applyAccent('gray', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe(
      'oklch(72% 0 286)',
    )
  })

  it('uses the hand-tuned neutral gradient in light mode', () => {
    applyAccent('gray', null)
    expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe(
      'linear-gradient(135deg, oklch(0.59 0 0), oklch(0.49 0 0))',
    )
  })

  it('uses the hand-tuned neutral gradient in dark mode', () => {
    document.documentElement.classList.add('dark')
    applyAccent('gray', null)
    expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe(
      'linear-gradient(135deg, oklch(0.51 0 0), oklch(0.42 0 0))',
    )
  })

  it('pins the gradient-disabled solid fill to a safe dark gray', () => {
    setGradientEnabled(false)
    applyAccent('gray', null)
    // solidPrimaryOverride — the generic grayscale light solid (L60%) fails AA.
    expect(document.documentElement.style.getPropertyValue('--grad-primary')).toBe('oklch(45% 0 0)')
    setGradientEnabled(true)
  })

  // AA GUARD (load-bearing): a future tweak to the gray accent L that drops
  // white-on-accent below WCAG AA 4.5:1 must fail this test. CLAUDE.md marks AA
  // as non-negotiable.
  it('keeps white-on-accent contrast above AA in light mode', () => {
    applyAccent('gray', null)
    const l = oklchLightness(document.documentElement.style.getPropertyValue('--color-accent'))
    expect(whiteContrastForGray(l)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps white text above AA on the gradient-disabled solid fill', () => {
    // The gray CTA gradient itself is deliberately sub-AA, but the solid fill
    // used when gradients are disabled (solidPrimaryOverride oklch(45% 0 0))
    // must stay above AA for white text.
    expect(whiteContrastForGray(0.45)).toBeGreaterThanOrEqual(4.5)
  })

  it('desaturates chart accent colors', () => {
    expect(getChartAccentColors('gray', null, false).primary).toBe('oklch(60% 0 286)')
    expect(getChartAccentColors('gray', null, true).primary).toBe('oklch(70% 0 286)')
  })

  // Guard the chroma-0 contract across EVERY accent token (not just --color-accent),
  // in both modes. A refactor of buildTokens that re-introduces chroma on any of
  // these would break the grayscale promise; this catches it.
  const ACCENT_VARS = [
    '--color-accent',
    '--color-accent-hover',
    '--color-accent-soft',
    '--color-editor-selection',
    '--color-accent-text',
    '--color-focus-ring',
    '--grad-accent-soft',
    '--selected-border',
  ]
  for (const mode of ['light', 'dark'] as const) {
    it(`renders all accent tokens at chroma 0 (${mode})`, () => {
      document.documentElement.classList.toggle('dark', mode === 'dark')
      applyAccent('gray', null)
      for (const v of ACCENT_VARS) {
        const val = document.documentElement.style.getPropertyValue(v)
        // Every oklch() in the token must have a 0 chroma slot: `L% 0 H`.
        const stops = val.match(/oklch\([^)]*\)/g) ?? []
        expect(stops.length).toBeGreaterThan(0)
        for (const stop of stops) {
          expect(stop).toMatch(/oklch\(\s*[\d.]+%\s+0\s/)
        }
      }
    })
  }

  it('zeros --surface-chroma-scale for gray and resets it to 1 for a chromatic preset', () => {
    applyAccent('gray', null)
    expect(document.documentElement.style.getPropertyValue('--surface-chroma-scale')).toBe('0')
    // Reset trap: the inline `0` persists on documentElement, so switching to a
    // chromatic preset MUST write `1` back — otherwise violet's surfaces would
    // stay neutral too.
    applyAccent('violet', null)
    expect(document.documentElement.style.getPropertyValue('--surface-chroma-scale')).toBe('1')
  })

  it('AA guard fails (as a negative control) if accent L is bumped too light', () => {
    // L=0.73 → 1.05/(0.73³+0.05) ≈ 2.4 < 4.5. Proves the guard discriminates,
    // so a future light-mode L bump above the AA ceiling would be caught.
    expect(whiteContrastForGray(0.73)).toBeLessThan(4.5)
  })

  // SuperX default: solid orange #fb923c with white on-accent text
  // (--color-fg-inverse = #ffffff). White-on-orange-600 is the product CTA look.
  it('keeps SuperX orange solid accent in dark mode', () => {
    document.documentElement.classList.add('dark')
    applyAccent('orange', null)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#fb923c')
  })

  // DARK-MODE AA GUARD (oklch presets): buildTokens still produces L=0.72 for
  // non-fixed presets. On-accent text uses white (SuperX accent-fg); these
  // lighter oklch fills are art-directed and may sit below AA with white —
  // primary CTAs use gradient-primary + text-white with accepted trade-offs.
  // Guard here: oklch path still emits the expected L for non-orange presets.
  it('keeps oklch dark-mode accent lightness at L72 for non-fixed presets', () => {
    document.documentElement.classList.add('dark')
    for (const preset of ['violet', 'rose', 'sky', 'emerald', 'gray'] as const) {
      applyAccent(preset, null)
      const accentL = oklchLightness(
        document.documentElement.style.getPropertyValue('--color-accent'),
      )
      expect(accentL).toBeCloseTo(0.72, 5)
    }
  })

  it('dark-mode AA guard discriminates (negative control)', () => {
    // White (L=1) on a very light fill loses contrast — proves math is live.
    expect(grayContrast(0.95, 1)).toBeLessThan(4.5)
  })
})

describe('applyFont', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
  })

  it('sets Inter for both editor display and body', () => {
    applyFont('inter')
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toContain(
      'Inter',
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-body')).toContain('Inter')
  })

  it('sets Nunito for both editor display and body', () => {
    applyFont('nunito')
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toContain(
      'Nunito',
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-body')).toContain(
      'Nunito',
    )
  })

  it('sets Open Sans for open-sans with bumped weight 500', () => {
    applyFont('open-sans')
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toContain(
      'Open Sans',
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-body')).toContain(
      'Open Sans',
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-weight')).toBe('500')
  })

  it('sets weight 400 for fonts without a bumped weight', () => {
    applyFont('inter')
    expect(document.documentElement.style.getPropertyValue('--font-editor-weight')).toBe('400')
  })

  it('sets Fuzzy Bubbles for fuzzy-bubbles', () => {
    applyFont('fuzzy-bubbles')
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toContain(
      'Fuzzy Bubbles',
    )
  })

  it('does NOT touch app-level --font-display or --font-sans (Font setting is editor-only)', () => {
    applyFont('inter')
    expect(document.documentElement.style.getPropertyValue('--font-display')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('')
  })
})

describe('clampFontSize', () => {
  it('returns FONT_SIZE_DEFAULT for non-finite input', () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT)
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(FONT_SIZE_DEFAULT)
  })

  it('clamps to FONT_SIZE_MIN below the floor', () => {
    expect(clampFontSize(0)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(FONT_SIZE_MIN - 1)).toBe(FONT_SIZE_MIN)
  })

  it('clamps to FONT_SIZE_MAX above the ceiling', () => {
    expect(clampFontSize(FONT_SIZE_MAX + 1)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX)
  })

  it('rounds non-integer input to nearest integer', () => {
    expect(clampFontSize(14.4)).toBe(14)
    expect(clampFontSize(14.6)).toBe(15)
    expect(clampFontSize(15.5)).toBe(16)
  })

  it('passes through valid in-range integers unchanged', () => {
    expect(clampFontSize(FONT_SIZE_MIN)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(15)).toBe(15)
    expect(clampFontSize(FONT_SIZE_MAX)).toBe(FONT_SIZE_MAX)
  })
})

describe('clampFontContrast', () => {
  it('returns FONT_CONTRAST_DEFAULT for non-finite input', () => {
    expect(clampFontContrast(Number.NaN)).toBe(FONT_CONTRAST_DEFAULT)
  })

  it('clamps to FONT_CONTRAST_MIN below the floor', () => {
    expect(clampFontContrast(0)).toBe(FONT_CONTRAST_MIN)
    expect(clampFontContrast(-1)).toBe(FONT_CONTRAST_MIN)
  })

  it('clamps to FONT_CONTRAST_MAX above the ceiling', () => {
    expect(clampFontContrast(2)).toBe(FONT_CONTRAST_MAX)
  })

  it('snaps to step grid (0.05) to avoid float drift across persist cycles', () => {
    // Pick values inside [FONT_CONTRAST_MIN, FONT_CONTRAST_MAX] so the clamp
    // doesn't dominate — we're isolating the step-snap behavior here.
    expect(clampFontContrast(0.73)).toBeCloseTo(0.75, 5)
    expect(clampFontContrast(0.86)).toBeCloseTo(0.85, 5)
    expect(clampFontContrast(0.875)).toBeCloseTo(0.9, 5)
  })

  it('returns exact decimals (no float artifacts) for in-range values', () => {
    // Was failing before the round-to-2-decimals fix: 0.7 → 0.7000000000000001.
    expect(clampFontContrast(0.7)).toBe(0.7)
    expect(clampFontContrast(0.85)).toBe(0.85)
  })

  it('passes through exact step values', () => {
    expect(clampFontContrast(0.6)).toBeCloseTo(0.6, 5)
    expect(clampFontContrast(1.0)).toBeCloseTo(1.0, 5)
  })
})

describe('defaultFontSizeFor', () => {
  // Per-font preferred defaults — these doubles as a contract test against
  // DEFAULT_FONT_SIZE_BY_FAMILY so a typo or accidental reshuffle is caught.
  const expected: Record<FontFamily, number> = {
    geist: 14,
    inter: 14,
    nunito: 15,
    'open-sans': 14,
    'fuzzy-bubbles': 14,
    custom: 14,
  }
  for (const [family, px] of Object.entries(expected) as [FontFamily, number][]) {
    it(`returns ${px} for ${family}`, () => {
      expect(defaultFontSizeFor(family)).toBe(px)
    })
  }
})

describe('applyFontSize', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
  })

  it('sets --font-editor-size in px on the html element', () => {
    applyFontSize(16)
    expect(document.documentElement.style.getPropertyValue('--font-editor-size')).toBe('16px')
  })

  it('clamps before applying (out-of-range input never reaches the DOM)', () => {
    applyFontSize(999)
    expect(document.documentElement.style.getPropertyValue('--font-editor-size')).toBe(
      `${FONT_SIZE_MAX}px`,
    )
  })

  it('handles NaN safely by falling back to FONT_SIZE_DEFAULT', () => {
    applyFontSize(Number.NaN)
    expect(document.documentElement.style.getPropertyValue('--font-editor-size')).toBe(
      `${FONT_SIZE_DEFAULT}px`,
    )
  })
})

describe('applyFontContrast', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = ''
  })

  it('sets --font-editor-fg-alpha as a unitless number', () => {
    applyFontContrast(0.7)
    // After clamp snaps to step grid (0.05); 0.7 is already on a step.
    expect(document.documentElement.style.getPropertyValue('--font-editor-fg-alpha')).toBe('0.7')
  })

  it('clamps before applying', () => {
    applyFontContrast(0)
    expect(
      Number.parseFloat(document.documentElement.style.getPropertyValue('--font-editor-fg-alpha')),
    ).toBeCloseTo(FONT_CONTRAST_MIN, 5)
  })
})

describe('applyFont — custom variant', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('uses the custom family name and weight when family is "custom"', () => {
    applyFont('custom', 'Merriweather', 700)
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toBe(
      "'Merriweather', system-ui, sans-serif",
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-body')).toBe(
      "'Merriweather', system-ui, sans-serif",
    )
    expect(document.documentElement.style.getPropertyValue('--font-editor-weight')).toBe('700')
  })

  it('defaults weight to 400 when omitted', () => {
    applyFont('custom', 'Roboto')
    expect(document.documentElement.style.getPropertyValue('--font-editor-weight')).toBe('400')
  })

  it('falls through to FONT_MAP placeholder when custom name is missing', () => {
    applyFont('custom', null, null)
    // Placeholder display is system-ui, sans-serif (no quotes around family).
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toBe(
      'system-ui, sans-serif',
    )
  })

  it('keeps original behavior for built-in families', () => {
    applyFont('inter')
    expect(document.documentElement.style.getPropertyValue('--font-editor-display')).toContain(
      'Inter',
    )
  })

  it('strips embedded quotes/backslashes/semicolons from custom family name (defense-in-depth)', () => {
    applyFont('custom', `Mali'cious"\\;name`, 400)
    const css = document.documentElement.style.getPropertyValue('--font-editor-display')
    // Only the wrapping quotes remain; every sanitised char inside is gone.
    expect(css).toBe("'Maliciousname', system-ui, sans-serif")
  })

  it('sanitises quotes/backslashes/semicolons from <font-family> in @font-face rule too', () => {
    document.getElementById('custom-google-font')?.remove()
    loadCustomGoogleFont(`Roboto";color:red;`, 400, 'asset://x.woff2')
    const el = document.getElementById('custom-google-font') as HTMLStyleElement
    // The injected `;` and `"` are stripped — the trailing `:red` survives
    // but is harmless inside the single-quoted font-family string literal.
    expect(el.textContent).toContain("font-family: 'Robotocolor:red'")
    expect(el.textContent).not.toContain(';color')
  })
})

describe('loadCustomGoogleFont / unloadCustomGoogleFont', () => {
  beforeEach(() => {
    // Remove any prior <style id="custom-google-font">.
    document.getElementById('custom-google-font')?.remove()
  })

  it('injects a <style> element with the requested @font-face rule', () => {
    loadCustomGoogleFont('Roboto', 400, 'asset://localhost/roboto.woff2')
    const el = document.getElementById('custom-google-font') as HTMLStyleElement | null
    expect(el).not.toBeNull()
    expect(el!.textContent).toContain("font-family: 'Roboto'")
    expect(el!.textContent).toContain('font-weight: 400')
    expect(el!.textContent).toContain('url("asset://localhost/roboto.woff2")')
  })

  it('replaces (does not duplicate) the style element on repeat calls', () => {
    loadCustomGoogleFont('A', 400, 'asset://a.woff2')
    loadCustomGoogleFont('B', 700, 'asset://b.woff2')
    const all = document.querySelectorAll('#custom-google-font')
    expect(all.length).toBe(1)
    expect(all[0].textContent).toContain("font-family: 'B'")
    expect(all[0].textContent).toContain('font-weight: 700')
  })

  it('unloadCustomGoogleFont removes the injected element', () => {
    loadCustomGoogleFont('X', 400, 'asset://x.woff2')
    expect(document.getElementById('custom-google-font')).not.toBeNull()
    unloadCustomGoogleFont()
    expect(document.getElementById('custom-google-font')).toBeNull()
  })

  it('unloadCustomGoogleFont is a no-op when no element exists', () => {
    expect(() => unloadCustomGoogleFont()).not.toThrow()
  })
})
