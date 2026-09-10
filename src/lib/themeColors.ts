import { readActiveDesignSystem, type SurfaceStyle } from './designSystem'

export type { SurfaceStyle }
export { coerceSurfaceStyle, DEFAULT_SURFACE_STYLE, SURFACE_STYLES } from './designSystem'

export type AccentPreset = 'orange' | 'violet' | 'rose' | 'sky' | 'emerald' | 'gray' | 'custom'
export type FontFamily = 'geist' | 'inter' | 'nunito' | 'open-sans' | 'fuzzy-bubbles' | 'custom'

/** SuperX brand orange — legacy brand accent, still a selectable preset. The
 *  product default is now sky (see DEFAULT_ACCENT_PRESET in accentPresets.ts);
 *  history: docs/context/SURFACE-STYLES-superx.md. */
export const SUPERX_ORANGE = '#fb923c'
export const SUPERX_ORANGE_HOVER = '#fdba74'

interface AccentTokens {
  accent: string
  accentHover: string
  accentSoft: string
  editorSelection: string
  accentText: string
  focusRing: string
  accentRgb: string
  gradPrimary: string
  solidPrimary: string
  gradAccentSoft: string
  shadowGlow: string
  selectedBorder: string
  accentFill: string
  /** Clay-only (§4): extrusion edge, opaque hover wash. */
  accentDeep?: string
  accentWash?: string
  accentInk?: string
}

interface PresetDef {
  hue: number
  hex: string
  rgb: string
  /** Second hue for the glow halo's dual-hue blend (--shadow-primary-glow). The
   *  CTA gradient fill itself is single-hue (dark → light of `hue`). */
  sweepHue: number
  /** Per-preset CTA gradient overrides (per mode). Replace the generic buildTokens
   *  gradient with hand-tuned per-preset stops. Gradient ONLY — they do NOT touch
   *  `solidPrimary`; the AA-safe gradient-disabled fill comes from buildTokens (or
   *  `solidPrimaryOverride`).
   *
   *  Decorative only (`gradient-border-primary` and glows). CTA fills use
   *  `--color-accent-fill` via the `gradient-primary` utility so
   *  `--color-fg-inverse` stays ≥ 4.5:1. Do not point button fills at these
   *  stops — several first-stops fail AA against white. */
  gradPrimaryLight?: string
  gradPrimaryDark?: string
  /** AA-safe solid fill for the gradient-disabled toggle (`_gradientEnabled=false`).
   *  Only `gray` needs it: the generic grayscale light solid is L60% (fails white
   *  AA at 3.95:1), so pin it to a safe dark gray. Mode-independent (achromatic).
   *  Orange pins SuperX solid so disabled-gradient matches the brand hex. */
  solidPrimaryOverride?: string
  /** CTA fill (`--color-accent-fill`) in both modes. High-chroma oklch at
   *  the lightest L that still clears 4.5:1 with white — mix-with-black
   *  drops chroma and turns orange/rose brown. */
  accentFillLight?: string
  /** Fully desaturated theme: zeroes the chroma of every accent token (grayscale). */
  grayscale?: boolean
  /**
   * SuperX-style fixed hex tokens (same accent across light/dark). When set,
   * applyAccent uses these instead of the generic oklch buildTokens path so
   * soft fills mix into the surface (not pure orange washes).
   */
  fixedHexTokens?: boolean
}

const PRESETS: Record<Exclude<AccentPreset, 'custom'>, PresetDef> = {
  // SuperX brand orange — legacy brand preset (product default is now sky).
  orange: {
    hue: 41,
    hex: SUPERX_ORANGE,
    rgb: '251 146 60',
    sweepHue: 25,
    fixedHexTokens: true,
    // Primary CTA gradient uses orange-500 (#f97316) → orange-400 (#fb923c) for a
    // deeper, more clickable fill than the text-accent tokens (which stay at
    // orange-400/#fb923c). solidPrimaryOverride stays orange-400 so the
    // gradient-disabled fallback matches the text-accent, not the CTA gradient.
    gradPrimaryLight: 'linear-gradient(135deg, #f97316, #fb923c)',
    gradPrimaryDark: 'linear-gradient(135deg, #f97316, #fb923c)',
    solidPrimaryOverride: SUPERX_ORANGE,
    // Hue 50 (red-orange) at high C reads as orange, not brown, at AA L.
    accentFillLight: 'oklch(56% 0.2 50)',
  },
  violet: {
    hue: 280,
    hex: '#a78bfa',
    rgb: '167 139 250',
    sweepHue: 350, // violet → pink
    gradPrimaryLight: 'linear-gradient(135deg, oklch(0.66 0.2 289.6), oklch(0.58 0.16 283.36))',
    gradPrimaryDark: 'linear-gradient(135deg, oklch(0.57 0.27 291.07), oklch(0.51 0.19 281.25))',
    accentFillLight: 'oklch(56% 0.2 280)',
  },
  rose: {
    hue: 350,
    hex: '#f43f5e',
    rgb: '244 63 94',
    sweepHue: 50, // rose (glow sweeps → warm yellow)
    gradPrimaryLight: 'linear-gradient(135deg, oklch(0.76 0.23 345.18), oklch(0.65 0.21 348.87))',
    gradPrimaryDark: 'linear-gradient(135deg, oklch(0.75 0.23 346.83), oklch(0.6 0.21 347.23))',
    accentFillLight: 'oklch(57% 0.2 350)',
  },
  sky: {
    hue: 230,
    hex: '#0ea5e9',
    rgb: '14 165 233',
    sweepHue: 290, // sky → purple
    gradPrimaryLight: 'linear-gradient(135deg, oklch(0.8 0.14 226.02), oklch(0.64 0.16 234.21))',
    gradPrimaryDark: 'linear-gradient(135deg, oklch(0.71 0.17 250.98), oklch(0.59 0.14 237.86))',
    accentFillLight: 'oklch(53% 0.2 230)',
  },
  emerald: {
    hue: 160,
    hex: '#10b981',
    rgb: '16 185 129',
    sweepHue: 220, // green → teal-blue
    gradPrimaryLight: 'linear-gradient(135deg, oklch(0.77 0.23 160.1), oklch(0.64 0.17 161.62))',
    gradPrimaryDark: 'linear-gradient(135deg, oklch(0.71 0.2 151.18), oklch(0.57 0.18 157.21))',
    accentFillLight: 'oklch(52% 0.2 160)',
  },
  // Achromatic theme: every accent token renders at chroma 0 (pure gray). The
  // hue (286, the graphite surface hue) is irrelevant at chroma 0 but kept
  // coherent with --surface-hue. Uses the hand-tuned neutral CTA gradients
  // (same mechanism as the chromatic presets). The gradient-disabled solid fill
  // is pinned to a safe dark gray via solidPrimaryOverride (the generic grayscale
  // light solid is L60% and fails white-text AA).
  gray: {
    hue: 286,
    hex: '#737373',
    rgb: '115 115 115',
    sweepHue: 286,
    grayscale: true,
    gradPrimaryLight: 'linear-gradient(135deg, oklch(0.59 0 0), oklch(0.49 0 0))',
    gradPrimaryDark: 'linear-gradient(135deg, oklch(0.51 0 0), oklch(0.42 0 0))',
    solidPrimaryOverride: 'oklch(45% 0 0)',
    accentFillLight: 'oklch(52% 0 286)',
  },
}

/** True when the preset is a fully-desaturated (chroma 0) theme. */
function isGrayscalePreset(preset: AccentPreset): boolean {
  if (preset === 'custom') return false
  return PRESETS[preset as Exclude<AccentPreset, 'custom'>]?.grayscale ?? false
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

function hexToHue(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16) / 255
  const g = parseInt(h.substring(2, 4), 16) / 255
  const b = parseInt(h.substring(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let hue: number
  if (max === r) hue = ((g - b) / d) % 6
  else if (max === g) hue = (b - r) / d + 2
  else hue = (r - g) / d + 4
  hue = Math.round(hue * 60)
  if (hue < 0) hue += 360
  return hue
}

// Mirrors the graphite design-system accent tokens in globals.css (`.dark` +
// `:root`), parametrized by hue so the runtime accent picker stays on-brand.
// At hue 280 (the violet default) these produce EXACTLY the static globals.css
// values — borders/fg text stay static; accent-derived tokens (accent, hover,
// soft, text, focus, the 160° CTA gradient, glow shadow, selected border)
// recolour here, and the surface hue is retuned separately via `--surface-hue`
// in applyAccent. Keep oklch-based (not hex/rgb) to match the system.
// In dark mode the lighter accent variants (hi/hover/text) sit 2° cooler than
// the base hue, matching globals.css `--color-accent-hover` /
// `--color-accent-text` at 282 when hue = 280.
function buildTokens(
  hue: number,
  sweepHue: number,
  rgb: string,
  isDark: boolean,
  grayscale = false,
): AccentTokens {
  // Chroma gate: a grayscale theme collapses every accent token to chroma 0 so
  // the whole UI reads black/white. For chromatic presets this is a no-op.
  const c = (v: number) => (grayscale ? 0 : v)
  let tokens: AccentTokens
  if (isDark) {
    // Dark mode: single-hue CTA gradient sweeping dark → light (L42→58% of the
    // same `hue`), grounded against the near-black canvas with good white-text
    // contrast. Dark-mode L is unchanged for grayscale: the light accent sits on
    // the dark canvas (not behind white text), so contrast is already comfortable
    // at chroma 0.
    tokens = {
      accent: `oklch(72% ${c(0.15)} ${hue})`,
      accentHover: `oklch(80% ${c(0.13)} ${hue + 2})`,
      accentSoft: `oklch(72% ${c(0.15)} ${hue} / 0.14)`,
      editorSelection: `oklch(72% ${c(0.15)} ${hue} / 0.35)`,
      accentText: `oklch(80% ${c(0.13)} ${hue + 2})`,
      focusRing: `oklch(82% ${c(0.16)} ${hue})`,
      accentRgb: rgb,
      gradPrimary: `linear-gradient(135deg, oklch(42% ${c(0.27)} ${hue}), oklch(58% ${c(0.25)} ${hue}))`,
      solidPrimary: `oklch(49% ${c(0.27)} ${hue})`,
      gradAccentSoft: `linear-gradient(135deg, oklch(72% ${c(0.15)} ${hue} / 0.14) 0%, oklch(72% ${c(0.15)} ${hue} / 0.08) 100%)`,
      shadowGlow: `0 4px 16px -6px oklch(49% ${c(0.27)} ${hue} / 0.35), 0 1px 3px oklch(58% ${c(0.25)} ${sweepHue} / 0.18)`,
      selectedBorder: `oklch(72% ${c(0.15)} ${hue} / 0.38)`,
      // Same chroma-preserving CTA fill as light — mix-with-black reads muddy
      // on dark paper. Per-preset `accentFillLight` overrides this.
      accentFill: grayscale ? `oklch(52% 0 ${hue})` : `oklch(52% 0.2 ${hue})`,
    }
  } else {
    // Light mode: chrome accent stays L55% (icons, bars, `text-accent`). CTA
    // fill is a separate high-chroma stop (overridden per-preset via
    // `accentFillLight`) — mixing the chrome color with black collapses chroma
    // and turns orange brown. `accent-text` stays at L48% for AA on paper.
    // Grayscale uses a deliberately muted, darker accent (L=45%) — a stylistic
    // choice for a calm gray; it also keeps white-on-accent contrast comfortably
    // above AA (1.05/(0.45³+0.05) ≈ 7.4:1).
    const lAccent = grayscale ? 45 : 55
    const lHover = grayscale ? 40 : 48
    const lFocus = grayscale ? 45 : 52
    tokens = {
      accent: `oklch(${lAccent}% ${c(0.18)} ${hue})`,
      accentHover: `oklch(${lHover}% ${c(0.2)} ${hue})`,
      accentSoft: `oklch(60% ${c(0.13)} ${hue} / 0.08)`,
      editorSelection: `oklch(${lAccent}% ${c(0.18)} ${hue} / 0.3)`,
      accentText: `oklch(${lHover}% ${c(0.2)} ${hue})`,
      focusRing: `oklch(${lFocus}% ${c(0.2)} ${hue})`,
      accentRgb: rgb,
      gradPrimary: `linear-gradient(135deg, oklch(50% ${c(0.27)} ${hue}), oklch(65% ${c(0.24)} ${hue}))`,
      solidPrimary: `oklch(60% ${c(0.27)} ${hue})`,
      gradAccentSoft: `linear-gradient(135deg, oklch(60% ${c(0.13)} ${hue} / 0.08) 0%, oklch(60% ${c(0.13)} ${hue} / 0.045) 100%)`,
      shadowGlow: `0 6px 20px -6px oklch(60% ${c(0.27)} ${hue} / 0.4), 0 2px 6px oklch(65% ${c(0.24)} ${sweepHue} / 0.2)`,
      selectedBorder: `oklch(60% ${c(0.13)} ${hue} / 0.26)`,
      accentFill: grayscale ? `oklch(52% 0 ${hue})` : `oklch(52% 0.2 ${hue})`,
    }
  }
  return tokens
}

/** Clay Press accent (docs/design/DESIGN_clay.md §4). `acc` is the solid
 *  slab fill, `deep` the extrusion edge, `wash` an opaque hover wash,
 *  `ghost` a transparent hover wash, `text` the AA text-on-paper colour.
 *  (The kit's `--acc-soft` pastel tint has no consumer here and is omitted.) Labels on `acc` are the kit's white `--on-primary`
 *  (`--color-fg-inverse`). */
interface ClayPalette {
  acc: string
  deep: string
  /** Dark mode only: kit `--acc-ink`, the near-black accent used as the
   *  primary label (white on the lifted dark fills is 2.3–2.9:1). */
  ink?: string
  wash: string
  ghost: string
  text: string
}

/** `text` is verified ≥ 4.5:1 on Clay paper (themeColors.test.ts): kit
 *  `deep` alone is 2.96–5.54 on paper, so light `text` is `deep` mixed 40%
 *  toward the kit's `--acc-ink`; dark `text` = `acc`. The kit keeps primary
 *  labels white by design direction (white on `acc` is 2.3–4.6:1). */
export const CLAY_ACCENTS: Record<
  Exclude<AccentPreset, 'custom'>,
  { light: ClayPalette; dark: ClayPalette }
> = {
  orange: {
    light: {
      acc: '#e28a45',
      deep: '#c46d2c',
      wash: '#f6e4d2',
      ghost: 'rgb(226 138 69 / 0.14)',
      text: '#8d4f20',
    },
    dark: {
      acc: '#e39a5c',
      ink: '#2a1608',
      deep: '#b56d32',
      wash: '#3a2a1c',
      ghost: 'rgb(227 154 92 / 0.16)',
      text: '#e39a5c',
    },
  },
  violet: {
    light: {
      acc: '#7e73c4',
      deep: '#6157a6',
      wash: '#e6e3f4',
      ghost: 'rgb(126 115 196 / 0.16)',
      text: '#463e7a',
    },
    dark: {
      acc: '#9a91d4',
      ink: '#161226',
      deep: '#6a61ab',
      wash: '#2b2840',
      ghost: 'rgb(154 145 212 / 0.16)',
      text: '#9a91d4',
    },
  },
  rose: {
    light: {
      acc: '#d36b86',
      deep: '#b54f6b',
      wash: '#f6e0e6',
      ghost: 'rgb(211 107 134 / 0.15)',
      text: '#84384e',
    },
    dark: {
      acc: '#e0849a',
      ink: '#2a1018',
      deep: '#b45a72',
      wash: '#3a222a',
      ghost: 'rgb(224 132 154 / 0.16)',
      text: '#e0849a',
    },
  },
  sky: {
    light: {
      acc: '#4fa3c4',
      deep: '#3486a8',
      wash: '#d9eef5',
      ghost: 'rgb(79 163 196 / 0.16)',
      text: '#25617a',
    },
    dark: {
      acc: '#68b6d2',
      ink: '#0a1e26',
      deep: '#3d86a3',
      wash: '#1c323a',
      ghost: 'rgb(104 182 210 / 0.16)',
      text: '#68b6d2',
    },
  },
  emerald: {
    light: {
      acc: '#3e9a74',
      deep: '#2d7a5a',
      wash: '#d7eee4',
      ghost: 'rgb(62 154 116 / 0.16)',
      text: '#205841',
    },
    dark: {
      acc: '#56b38a',
      ink: '#071c14',
      deep: '#2f7d5e',
      wash: '#1b3228',
      ghost: 'rgb(86 179 138 / 0.16)',
      text: '#56b38a',
    },
  },
  gray: {
    light: {
      acc: '#7a756c',
      deep: '#5d5850',
      wash: '#e6e1d8',
      ghost: 'rgb(122 117 108 / 0.16)',
      text: '#433f39',
    },
    dark: {
      acc: '#b0aaa1',
      ink: '#161412',
      deep: '#6e6962',
      wash: '#2c2925',
      ghost: 'rgb(176 170 161 / 0.14)',
      text: '#b0aaa1',
    },
  },
}

/** Custom hex under Clay: same palette shape derived from the hue, at the
 *  L/C steps the kit accents sit at. */
function clayPaletteFromHue(hue: number, isDark: boolean): ClayPalette {
  return isDark
    ? {
        acc: `oklch(72% 0.11 ${hue})`,
        deep: `oklch(55% 0.11 ${hue})`,
        ink: `oklch(18% 0.04 ${hue})`,
        wash: `oklch(30% 0.04 ${hue})`,
        ghost: `oklch(72% 0.11 ${hue} / 0.16)`,
        text: `oklch(72% 0.11 ${hue})`,
      }
    : {
        acc: `oklch(62% 0.11 ${hue})`,
        deep: `oklch(52% 0.11 ${hue})`,
        wash: `oklch(92% 0.04 ${hue})`,
        ghost: `oklch(62% 0.11 ${hue} / 0.15)`,
        text: `oklch(42% 0.11 ${hue})`,
      }
}

/** Clay recipe §5: flat `acc` under a white-to-transparent top sheen. */
function claySlabFill(acc: string): string {
  return `linear-gradient(180deg, rgb(255 255 255 / 0.22), transparent 46%), ${acc}`
}

function buildClayTokens(p: ClayPalette, rgb: string, isDark: boolean): AccentTokens {
  return {
    accent: p.acc,
    accentHover: isDark ? `color-mix(in oklab, ${p.acc} 88%, #ffffff)` : p.deep,
    accentSoft: p.ghost,
    editorSelection: `color-mix(in srgb, ${p.acc} 35%, transparent)`,
    accentText: p.text,
    /* Light: the pastel slab fill measures 2.07–2.71 on the cream papers, and
     * Clay's hairline is only 1.21:1 — so the ring would be the only boundary
     * a keyboard user gets, and an invisible one. `text` is already the
     * AA-on-paper value (5.04–8.21). Dark's `acc` is 5.27–7.99 and stays. */
    focusRing: isDark ? p.acc : p.text,
    accentRgb: rgb,
    gradPrimary: `linear-gradient(135deg, ${p.deep}, ${p.acc})`,
    solidPrimary: p.acc,
    gradAccentSoft: p.ghost,
    shadowGlow: `0 8px 20px ${p.ghost}`,
    selectedBorder: `color-mix(in srgb, ${p.acc} 40%, transparent)`,
    accentFill: p.acc,
    accentDeep: p.deep,
    accentWash: p.wash,
    accentInk: p.ink,
  }
}

let _gradientEnabled = true

export function setGradientEnabled(v: boolean): void {
  _gradientEnabled = v
}

/** SuperX fixed-hex accent tokens (orange). Soft fills mix into the surface. */
function buildFixedHexTokens(
  hex: string,
  hover: string,
  rgb: string,
  isDark: boolean,
  isClean: boolean,
): AccentTokens {
  const mixBase = isClean ? 'var(--color-elevated)' : isDark ? '#1c1c1c' : '#ffffff'
  const softPct = isClean ? 10 : isDark ? 16 : 12
  const accentSoft = `color-mix(in oklab, ${hex} ${softPct}%, ${mixBase})`
  return {
    accent: hex,
    accentHover: hover,
    accentSoft,
    editorSelection: `color-mix(in oklab, ${hex} 35%, transparent)`,
    // Dark mode: lighter hover for accent-colored icons/links on charcoal.
    // Light mode: deeper orange for AA text on paper.
    accentText: isDark ? hover : '#c2410c',
    focusRing: hex,
    accentRgb: rgb,
    gradPrimary: `linear-gradient(135deg, ${hex}, ${hover})`,
    solidPrimary: hex,
    gradAccentSoft: `linear-gradient(135deg, ${accentSoft} 0%, color-mix(in oklab, ${hex} ${softPct / 2}%, ${mixBase}) 100%)`,
    shadowGlow: `0 0 0 1px rgb(${rgb} / 0.3), 0 8px 20px rgb(${rgb} / 0.2)`,
    selectedBorder: `color-mix(in oklab, ${hex} ${isDark ? 38 : 26}%, transparent)`,
    accentFill: 'oklch(56% 0.2 50)',
  }
}

/** Two-stop CTA sweep from a chroma-preserving oklch fill. Both stops stay
 *  at or below the AA L of `fill` so white `--color-fg-inverse` still reads. */
function ctaFillGradient(fill: string): string {
  const match = /^oklch\(([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\)$/.exec(fill)
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return fill
  }
  const L = Number(match[1])
  const lo = Math.max(40, Math.round((L - 7) * 10) / 10)
  return `linear-gradient(165deg, oklch(${lo}% ${match[2]} ${match[3]}), ${fill})`
}

/**
 * Writes accent tokens as inline styles on `document.documentElement`.
 * Branches on the active design system the same way it already reads `isDark`
 * from the root class list — no signature change at call sites. Every
 * property written here is inline, so CSS cannot override it: Clean must
 * flatten gradients/glows in this function, not in a stylesheet. Clay must
 * swap in its kit palette here for the same reason.
 */
export function applyAccent(preset: AccentPreset, customHex: string | null): void {
  const isDark = document.documentElement.classList.contains('dark')
  const designSystem = readActiveDesignSystem()
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'
  let hue: number
  let rgb: string

  let sweepHue: number
  if (preset === 'custom' && customHex) {
    rgb = hexToRgb(customHex)
    hue = hexToHue(customHex)
    sweepHue = (hue + 65) % 360
  } else {
    // Defensive: unknown preset (e.g. a stale value persisted by an earlier
    // build) falls back to the sky default rather than crashing on `undefined.hue`.
    const def = PRESETS[preset as Exclude<AccentPreset, 'custom'>] ?? PRESETS.sky
    hue = def.hue
    rgb = def.rgb
    sweepHue = def.sweepHue
  }

  // Defensive: a malformed custom hex makes hexToHue return NaN, which would
  // write "NaN" into the oklch() hue slot (silently ignored by CSS). Fall back
  // to the sky default hue so surfaces and accent stay coherent.
  if (!Number.isFinite(hue)) hue = PRESETS.sky.hue
  if (!Number.isFinite(sweepHue)) sweepHue = PRESETS.sky.sweepHue

  const grayscale = isGrayscalePreset(preset)
  const presetDef =
    preset === 'custom' ? null : (PRESETS[preset as Exclude<AccentPreset, 'custom'>] ?? PRESETS.sky)

  let tokens: AccentTokens
  if (isClay) {
    // Clay Press palette: every named preset (SuperX orange included) reads
    // the kit sheet; a custom hex derives the same shape from its hue.
    const sheet =
      preset === 'custom'
        ? null
        : (CLAY_ACCENTS[preset as Exclude<AccentPreset, 'custom'>] ?? CLAY_ACCENTS.sky)
    const palette = sheet ? (isDark ? sheet.dark : sheet.light) : clayPaletteFromHue(hue, isDark)
    tokens = buildClayTokens(palette, sheet ? hexToRgb(palette.acc) : rgb, isDark)
  } else if (presetDef?.fixedHexTokens) {
    tokens = buildFixedHexTokens(presetDef.hex, SUPERX_ORANGE_HOVER, rgb, isDark, isClean)
  } else {
    tokens = buildTokens(hue, sweepHue, rgb, isDark, grayscale)
  }
  if (presetDef && !isClay) {
    // Per-preset --grad-primary (decorative borders / glows only — CTA fills
    // use --color-accent-fill via the gradient-primary utility). solidPrimary
    // is the gradient-off / Clean flat stop.
    const grad = isDark ? presetDef.gradPrimaryDark : presetDef.gradPrimaryLight
    if (grad) tokens.gradPrimary = grad
    if (presetDef.solidPrimaryOverride) tokens.solidPrimary = presetDef.solidPrimaryOverride
    if (presetDef.accentFillLight) tokens.accentFill = presetDef.accentFillLight
  }
  const s = document.documentElement.style
  // Hue is still written for decorative glows that reference --surface-hue
  // (media badge, legacy oklch surfaces). SuperX panels are fixed hex neutrals
  // and do not tint with accent.
  s.setProperty('--surface-hue', String(hue))
  // Grayscale presets zero decorative chroma. Written on EVERY call so switching
  // off gray resets inline `0` back to `1`.
  s.setProperty('--surface-chroma-scale', grayscale ? '0' : '1')
  s.setProperty('--color-accent', tokens.accent)
  s.setProperty('--color-accent-hover', tokens.accentHover)
  s.setProperty('--color-accent-soft', tokens.accentSoft)
  s.setProperty('--color-editor-selection', tokens.editorSelection)
  s.setProperty('--color-accent-text', tokens.accentText)
  s.setProperty('--color-focus-ring', tokens.focusRing)
  s.setProperty('--accent-rgb', tokens.accentRgb)
  s.setProperty('--grad-primary', _gradientEnabled ? tokens.gradPrimary : tokens.solidPrimary)
  s.setProperty('--grad-accent-soft', tokens.gradAccentSoft)
  s.setProperty('--shadow-primary-glow', tokens.shadowGlow)
  s.setProperty('--selected-border', tokens.selectedBorder)
  s.setProperty('--color-accent-fill', tokens.accentFill)
  // Clay-only slab tokens; harmless (unread) under Signature / Clean.
  s.setProperty('--color-accent-deep', tokens.accentDeep ?? tokens.accentHover)
  s.setProperty('--color-accent-wash', tokens.accentWash ?? tokens.accentSoft)
  s.setProperty('--color-accent-ink', tokens.accentInk ?? 'var(--color-fg-inverse)')
  s.setProperty(
    '--grad-accent-fill',
    !_gradientEnabled || isClean
      ? tokens.accentFill
      : isClay
        ? claySlabFill(tokens.accentFill)
        : ctaFillGradient(tokens.accentFill),
  )

  if (isClean) {
    // Clean discards every gradient, glow and accent wash: shadcn paints
    // with flat fills and hairline borders only. `solidPrimary` is the
    // AA-safe flat fill the "Color gradient off" toggle already uses, so
    // Clean pins that path regardless of `_gradientEnabled`.
    s.setProperty('--grad-primary', tokens.solidPrimary)
    s.setProperty('--grad-accent-soft', tokens.accentSoft)
    s.setProperty('--shadow-primary-glow', 'none')
    s.setProperty('--selected-border', tokens.accent)
    s.setProperty('--surface-chroma-scale', '0')
  }
}

export function applySurfaceStyle(style: SurfaceStyle): void {
  // Deep/Soft/Lumen are Signature-only dark surfaces. XOR: at most one of
  // surface-soft / surface-lumen. Strip both under Clean and Clay so a
  // Signature-persisted preference cannot leak.
  const isSignature = readActiveDesignSystem() === 'signature'
  const root = document.documentElement.classList
  root.toggle('surface-soft', isSignature && style === 'soft')
  root.toggle('surface-lumen', isSignature && style === 'lumen')
}

// Per-font visual scale + body weight. Handwriting fonts with small x-heights
// and thin strokes need a size bump to read at the same visual weight as
// sans/serif options (applied via --font-editor-scale).
const FONT_MAP: Record<
  FontFamily,
  { display: string; body: string; scale: number; weight: number }
> = {
  geist: {
    display: "'Geist Variable', system-ui, sans-serif",
    body: "'Geist Variable', system-ui, sans-serif",
    scale: 1,
    weight: 400,
  },
  inter: {
    display: "'Inter Variable', system-ui, sans-serif",
    body: "'Inter Variable', system-ui, sans-serif",
    scale: 1,
    weight: 400,
  },
  nunito: {
    display: "'Nunito Variable', system-ui, sans-serif",
    body: "'Nunito Variable', system-ui, sans-serif",
    scale: 1,
    weight: 400,
  },
  'open-sans': {
    display: "'Open Sans', system-ui, sans-serif",
    body: "'Open Sans', system-ui, sans-serif",
    scale: 1,
    weight: 500,
  },
  'fuzzy-bubbles': {
    display: "'Fuzzy Bubbles', 'Comic Sans MS', cursive",
    body: "'Fuzzy Bubbles', 'Comic Sans MS', cursive",
    scale: 1,
    weight: 400,
  },
  // Placeholder for the "Custom Google Font" slot. `applyFont('custom', ...)`
  // overrides these at runtime with the chosen family + weight; the values
  // here are only the fallback used when no custom font has been picked yet
  // (or after the cache is cleared).
  custom: {
    display: 'system-ui, sans-serif',
    body: 'system-ui, sans-serif',
    scale: 1,
    weight: 400,
  },
}

/**
 * Single source of truth for sanitising a Google Font family name before
 * embedding it in a CSS string. Strips single quotes, double quotes,
 * backslashes, semicolons, and any control characters. The family name is
 * already whitelist-validated upstream by `fonts::validate_family` in the
 * Rust backend (alphanumerics + space/-/+ only), but defense-in-depth here
 * costs one regex and prevents drift if the upstream validator is ever
 * relaxed.
 */
export function sanitizeFontFamilyName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/['"\\;\n\r\x00-\x1f]/g, '')
}

export function applyFont(
  family: FontFamily,
  customFamilyName?: string | null,
  customWeight?: number | null,
): void {
  const s = document.documentElement.style
  if (family === 'custom' && customFamilyName) {
    const css = `'${sanitizeFontFamilyName(customFamilyName)}', system-ui, sans-serif`
    s.setProperty('--font-editor-display', css)
    s.setProperty('--font-editor-body', css)
    s.setProperty('--font-editor-scale', '1')
    s.setProperty('--font-editor-weight', String(customWeight ?? 400))
    return
  }
  // Fall back to the default face if a persisted family was removed from the
  // union (e.g. an old 'playpen-sans' value cast via `as FontFamily`) so
  // a stale setting never crashes on `fonts.display`.
  const fonts = FONT_MAP[family] ?? FONT_MAP.geist
  s.setProperty('--font-editor-display', fonts.display)
  s.setProperty('--font-editor-body', fonts.body)
  s.setProperty('--font-editor-scale', String(fonts.scale))
  s.setProperty('--font-editor-weight', String(fonts.weight))
}

const CUSTOM_FONT_STYLE_ID = 'custom-google-font'

/**
 * Inject (or replace) a runtime `@font-face` rule for a downloaded Google
 * Font. `localFileSrc` must be a Tauri-asset-protocol URL produced by
 * `convertFileSrc` so the browser can read the cached file.
 *
 * Idempotent: a previously injected `<style id="custom-google-font">` is
 * reused — never appended a second time.
 */
export function loadCustomGoogleFont(
  familyName: string,
  weight: number,
  localFileSrc: string,
): void {
  let el = document.getElementById(CUSTOM_FONT_STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = CUSTOM_FONT_STYLE_ID
    document.head.appendChild(el)
  }
  const safeFamily = sanitizeFontFamilyName(familyName)
  el.textContent = `@font-face {
  font-family: '${safeFamily}';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url("${localFileSrc}") format('woff2');
}`
}

/** Remove the injected `@font-face` rule, if any. Used by cache clear. */
export function unloadCustomGoogleFont(): void {
  document.getElementById(CUSTOM_FONT_STYLE_ID)?.remove()
}

export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 21
export const FONT_SIZE_DEFAULT = 13

// Per-font preferred default size in px. Fonts render at different perceived
// weights/x-heights, so each gets its own starting point. Falls back to
// FONT_SIZE_DEFAULT for any font not listed.
export const DEFAULT_FONT_SIZE_BY_FAMILY: Record<FontFamily, number> = {
  geist: 14,
  inter: 14,
  nunito: 15,
  'open-sans': 14,
  'fuzzy-bubbles': 14,
  custom: 14,
}

export function defaultFontSizeFor(family: FontFamily): number {
  return DEFAULT_FONT_SIZE_BY_FAMILY[family] ?? FONT_SIZE_DEFAULT
}

export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return FONT_SIZE_DEFAULT
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(px)))
}

export function applyFontSize(px: number): void {
  document.documentElement.style.setProperty('--font-editor-size', `${clampFontSize(px)}px`)
}

// Editor foreground opacity — user-tunable contrast. 1.0 = full strength
// (pure white in dark editor), 0.8 = previous default body strength (softer
// gray). Works in both light and dark mode because it scales the resolved
// --color-fg, which already inverts per theme.
// Foreground opacity floor is 0.6 (not lower) because color-mix(...,
// transparent) does an alpha drop, not a bg-aware lightness shift. In light
// mode `--color-fg` is dark; at 40% alpha against a near-white app bg the
// effective text contrast falls below WCAG AA 4.5:1. Empirically 0.6 keeps
// body text above AA in both light and dark mode. CLAUDE.md marks AA as
// non-negotiable, so this floor is load-bearing — do not lower it.
// Default 0.8 ≈ the old 1.0 look against dark canvas (when max base was
// #e2e2e2); 1.0 is now pure white headroom above that.
export const FONT_CONTRAST_MIN = 0.6
export const FONT_CONTRAST_MAX = 1.0
export const FONT_CONTRAST_DEFAULT = 0.8
export const FONT_CONTRAST_STEP = 0.05

export function clampFontContrast(v: number): number {
  if (!Number.isFinite(v)) return FONT_CONTRAST_DEFAULT
  // Snap to step grid (rounded to 2 decimals to undo float arithmetic
  // artifacts like 0.7 → 0.7000000000000001) to avoid drift across
  // persist/load cycles.
  const snapped = Math.round((v / FONT_CONTRAST_STEP) * 1) * FONT_CONTRAST_STEP
  const rounded = Math.round(snapped * 100) / 100
  return Math.max(FONT_CONTRAST_MIN, Math.min(FONT_CONTRAST_MAX, rounded))
}

export function applyFontContrast(v: number): void {
  document.documentElement.style.setProperty('--font-editor-fg-alpha', String(clampFontContrast(v)))
}

export function getContrastRatio(hex1: string, hex2: string): number {
  function luminance(hex: string): number {
    const h = hex.replace('#', '')
    const r = parseInt(h.substring(0, 2), 16) / 255
    const g = parseInt(h.substring(2, 4), 16) / 255
    const b = parseInt(h.substring(4, 6), 16) / 255
    const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  }
  const l1 = luminance(hex1)
  const l2 = luminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export function getPresetHex(preset: AccentPreset): string {
  if (preset === 'custom') return PRESETS.sky.hex
  // Defensive: a removed/unknown preset id (e.g. a persisted 'amber' from an
  // earlier build, cast from storage without validation) falls back to the
  // sky default — mirrors applyAccent / resolveHue / getChartAccentColors.
  return (PRESETS[preset] ?? PRESETS.sky).hex
}

export function isValidHex(hex: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(hex)
}

export interface ChartAccentColors {
  primary: string
  primaryActive: string
  scale: [string, string, string, string, string]
  heatGradient: Record<number, string>
}

function resolveHue(preset: AccentPreset, customHex: string | null): number {
  if (preset === 'custom' && customHex) return hexToHue(customHex)
  // Defensive: unknown preset falls back to the sky default (same as applyAccent).
  const def = PRESETS[preset as Exclude<AccentPreset, 'custom'>] ?? PRESETS.sky
  return def.hue
}

/** Writing-streak cell ramp for levels 1–4 — a FIXED green, deliberately
 *  independent of the accent preset. The streak grid means "days you wrote";
 *  rendering it in a warm accent (orange/red) reads as an alert instead of
 *  progress, so it opts out of `getChartAccentColors`. Hue 150 matches
 *  `--color-success` (`oklch(68% 0.16 150)`) and stays clear of the emotion
 *  palette's spring green (`#34D399`, hue ≈163) used by the EmotionHeatmap
 *  stacked below it. Level 0 comes from `HEATMAP_EMPTY_CELL`. */
export const STREAK_CELL_SCALE: {
  dark: [string, string, string, string]
  light: [string, string, string, string]
} = {
  dark: [
    'oklch(38% 0.08 150)',
    'oklch(50% 0.12 150)',
    'oklch(63% 0.15 150)',
    'oklch(76% 0.15 150)',
  ],
  light: [
    'oklch(90% 0.06 150)',
    'oklch(78% 0.12 150)',
    'oklch(62% 0.16 150)',
    'oklch(48% 0.14 150)',
  ],
}

/** "No entry" cell shared by both year heatmaps (StreakCalendar +
 *  EmotionHeatmap). Neutral gray, one step above the card it sits on — the
 *  charcoal ladder shifts between the two dark surface styles, so the empty
 *  cell has to shift with it (`--color-elevated` is #1c1c1c on Deep, #242424
 *  on Soft). Literal colours, not `var()`: the PNG export serializes the SVG
 *  standalone and can't resolve custom properties. */
/** Recharts / SVG chrome — CSS vars so both design systems paint the ticks. */
export const CHART_NEUTRAL = {
  grid: 'var(--color-border-default)',
  text: 'var(--color-fg-muted)',
  tooltip_bg: 'var(--color-elevated)',
  tooltip_border: 'var(--color-border-default)',
  /** Bar hover band. Recharts defaults to a hardcoded `#ccc`, which reads as a
   *  light-grey block on every dark skin. Washing the fg token keeps it
   *  mode-correct: lighter in dark, darker in light. */
  cursor_fill: 'var(--color-fg)',
  cursor_opacity: 0.06,
} as const

export const HEATMAP_EMPTY_CELL: Record<SurfaceStyle | 'light', string> = {
  deep: '#2a2a2a',
  soft: '#323232',
  // Lumen `--color-surface-hi` (`oklch(26% 0.02 263)`) baked to sRGB.
  lumen: '#1f242e',
  light: '#eeeeee',
}

export function getChartAccentColors(
  preset: AccentPreset,
  customHex: string | null,
  isDark: boolean,
): ChartAccentColors {
  const hue = resolveHue(preset, customHex)
  // Grayscale preset: zero the chroma of every stop and swap the hardcoded
  // slate endpoints for neutral grays so charts read black/white too. Detect via
  // the PRESETS flag (not a hardcoded id) so any future grayscale preset works.
  const grayscale = isGrayscalePreset(preset)
  const c = (v: number) => (grayscale ? 0 : v)
  if (isDark) {
    return {
      primary: `oklch(70% ${c(0.18)} ${hue})`,
      primaryActive: `oklch(80% ${c(0.15)} ${hue})`,
      scale: [
        grayscale ? '#1f1f1f' : '#141414',
        `oklch(35% ${c(0.18)} ${hue})`,
        `oklch(55% ${c(0.2)} ${hue})`,
        `oklch(70% ${c(0.18)} ${hue})`,
        `oklch(85% ${c(0.13)} ${hue})`,
      ],
      heatGradient: {
        0.2: `oklch(85% ${c(0.1)} ${hue})`,
        0.4: `oklch(75% ${c(0.15)} ${hue})`,
        0.6: `oklch(65% ${c(0.2)} ${hue})`,
        0.8: `oklch(55% ${c(0.2)} ${hue})`,
        1.0: `oklch(45% ${c(0.2)} ${hue})`,
      },
    }
  }
  return {
    primary: `oklch(60% ${c(0.2)} ${hue})`,
    primaryActive: `oklch(48% ${c(0.2)} ${hue})`,
    scale: [
      grayscale ? '#f4f4f4' : '#f4f3f1',
      `oklch(88% ${c(0.08)} ${hue})`,
      `oklch(72% ${c(0.16)} ${hue})`,
      `oklch(55% ${c(0.2)} ${hue})`,
      `oklch(40% ${c(0.18)} ${hue})`,
    ],
    heatGradient: {
      0.2: `oklch(85% ${c(0.1)} ${hue})`,
      0.4: `oklch(72% ${c(0.16)} ${hue})`,
      0.6: `oklch(60% ${c(0.2)} ${hue})`,
      0.8: `oklch(50% ${c(0.2)} ${hue})`,
      1.0: `oklch(40% ${c(0.18)} ${hue})`,
    },
  }
}
