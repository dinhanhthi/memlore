import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_ACCENT_HEX } from '../lib/accentPresets'
import { getContrastRatio } from '../lib/themeColors'

/**
 * Token presence tests for the Memlore design system (post-redesign).
 *
 * We parse globals.css as text (not via getComputedStyle) because jsdom
 * doesn't execute the Tailwind v4 `@utility` block and doesn't resolve
 * cascaded custom properties the way a real browser does. String-matching
 * the source is enough to catch accidental token removal during migration.
 */

/**
 * Tokens written inline by `applyAccent()`. A stylesheet value for any of
 * these is dead under Clean (inline styles win), so coverage parity with
 * the Signature `.dark` block does not require them. Adding a name here is
 * a deliberate exception — do not grow this list to silence a missing
 * Clean override.
 */
const CLEAN_INLINE_ONLY_TOKENS = [
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-soft',
  '--color-accent-text',
  '--color-accent-fill',
  '--color-editor-selection',
  '--color-focus-ring',
  '--accent-rgb',
  '--grad-primary',
  '--grad-accent-fill',
  '--grad-accent-soft',
  '--shadow-primary-glow',
  '--selected-border',
] as const

const CLEAN_INLINE_ONLY_TOKEN_SET: ReadonlySet<string> = new Set(CLEAN_INLINE_ONLY_TOKENS)

/** Body of a `{ … }` rule, given the source immediately after the opening `{`. */
function firstRuleBody(afterOpenBrace: string): string {
  let depth = 1
  for (let i = 0; i < afterOpenBrace.length; i++) {
    const ch = afterOpenBrace[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return afterOpenBrace.slice(0, i)
    }
  }
  return afterOpenBrace
}

function extractTopLevelRules(source: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = []
  let i = 0
  let selectorStart = 0
  while (i < source.length) {
    if (source[i] === '{') {
      const selector = source.slice(selectorStart, i).trim()
      const body = firstRuleBody(source.slice(i + 1))
      rules.push({ selector, body })
      i += 1 + body.length + 1
      selectorStart = i
      continue
    }
    i += 1
  }
  return rules
}

function selectorParts(selector: string): string[] {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function isCleanTokenSelector(selector: string): boolean {
  return selectorParts(selector).every(
    (part) => part === ':root.ds-clean' || part === ':root.dark.ds-clean',
  )
}

function isDarkCleanTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.dark.ds-clean')
}

function isLightCleanTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.ds-clean')
}

function isClayTokenSelector(selector: string): boolean {
  return selectorParts(selector).every(
    (part) => part === ':root.ds-clay' || part === ':root.dark.ds-clay',
  )
}

function isDarkClayTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.dark.ds-clay')
}

function isLightClayTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === ':root.ds-clay')
}

function isLumenTokenSelector(selector: string): boolean {
  return selectorParts(selector).every((part) => part === '.dark.surface-lumen')
}

/** Color / status / border / content-grad — the set `:root.dark.ds-clean` must own. */
function isCleanPaintToken(name: string): boolean {
  return name.startsWith('--color-') || name.startsWith('--content-grad-')
}

function mentionsDsClean(selector: string): boolean {
  return selector.includes('ds-clean')
}

function mentionsDsClay(selector: string): boolean {
  return selector.includes('ds-clay')
}

function mentionsSurfaceLumen(selector: string): boolean {
  return selector.includes('surface-lumen')
}

function customPropertyNames(block: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    const name = match[1]
    if (name !== undefined && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

function lastMatchIndex(source: string, re: RegExp): number {
  let last = -1
  for (const match of source.matchAll(new RegExp(re, 'g'))) {
    if (match.index !== undefined) last = match.index
  }
  return last
}

// ---------------------------------------------------------------------------
// WCAG AA helpers (test-local). No culori/colorjs in the app; OKLab matrices
// from Björn Ottosson / CSS Color 4. Achromatic oklch(L 0 0) has Y = L³.
// ---------------------------------------------------------------------------

type SurfaceId =
  | 'signature-light'
  | 'signature-dark'
  | 'signature-soft'
  | 'clean-light'
  | 'clean-dark'
  | 'lumen-dark'
  | 'clay-light'
  | 'clay-dark'

type Srgb = { r: number; g: number; b: number; a: number }

const WCAG_AA_MIN = 4.5

const FG_ROLES = ['--color-fg', '--color-fg-secondary', '--color-fg-muted'] as const
const SURFACE_ROLES = [
  '--color-app',
  '--color-panel-1',
  '--color-panel-2',
  '--color-panel-3',
  '--color-selected-tab',
  '--entry-card-hover-bg',
  '--color-elevated',
  '--color-surface-hi',
  '--color-chrome',
  // Settings rows hover the row container and carry `text-fg-muted` sub-copy
  // inside it (RemindersPanel, DeviceList, JournalsSettings, LocationSettings,
  // TemplatesSettings, ProvidersTab), so the hover fill is a text surface on
  // every skin — not a Clay-only one.
  '--color-surface-row-hover',
  '--nav-active-bg',
] as const
/** Clay-only text surfaces. `--color-surface-control` stays here: its only
 *  consumer is Button secondary, which labels with `text-fg` (see the Signature
 *  audit, finding 9) — Soft's #3f3f3f track would fail with muted ink. */
const CLAY_EXTRA_SURFACE_ROLES = ['--nav-rail-active-bg', '--color-surface-control'] as const
const STATUS_TEXT_ROLES = [
  '--color-danger-text',
  '--color-success-text',
  '--color-warning-text',
  '--color-info-text',
  '--color-empty-text',
] as const
// Status copy also lands on raised fills and on hovered settings rows, not
// just the flat page and card.
const STATUS_SURFACES = ['--color-app', '--color-elevated', '--color-surface-row-hover'] as const

const SHIPPING_SURFACES: { id: SurfaceId; label: string }[] = [
  { id: 'signature-light', label: 'Signature light (@theme)' },
  { id: 'signature-dark', label: 'Signature .dark' },
  { id: 'signature-soft', label: 'Signature .dark.surface-soft' },
  { id: 'clean-light', label: 'Clean light (:root.ds-clean)' },
  { id: 'clean-dark', label: 'Clean dark (:root.dark.ds-clean)' },
  { id: 'lumen-dark', label: 'Signature .dark.surface-lumen' },
  { id: 'clay-light', label: 'Clay light (:root.ds-clay)' },
  { id: 'clay-dark', label: 'Clay dark (:root.dark.ds-clay)' },
]

function parseDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) map.set(name, value.trim())
  }
  return map
}

function cascadeTokenMaps(...blocks: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    for (const [name, value] of parseDeclarations(block)) map.set(name, value)
  }
  return map
}

function resolveVars(
  value: string,
  tokens: Map<string, string>,
  seen: Set<string> = new Set(),
): string {
  return value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_full, name: string) => {
    if (seen.has(name)) throw new Error(`custom property cycle at ${name}`)
    // Clean blocks omit --color-accent (applyAccent writes it inline). The
    // stylesheet fallback is @theme / .dark Sky — the default preset.
    const next = tokens.get(name) ?? (name === '--color-accent' ? DEFAULT_ACCENT_HEX : undefined)
    if (next === undefined) throw new Error(`unresolved custom property ${name}`)
    const nextSeen = new Set(seen)
    nextSeen.add(name)
    return resolveVars(next, tokens, nextSeen)
  })
}

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgbChannel(c: number): number {
  const clamped = Math.min(1, Math.max(0, c))
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function parseHexColor(hex: string): Srgb {
  let h = hex.trim().slice(1)
  if (h.length === 3 || h.length === 4) {
    h = [...h].map((ch) => ch + ch).join('')
  }
  if (h.length !== 6 && h.length !== 8) {
    throw new Error(`unsupported hex color: ${hex}`)
  }
  const r = Number.parseInt(h.slice(0, 2), 16) / 255
  const g = Number.parseInt(h.slice(2, 4), 16) / 255
  const b = Number.parseInt(h.slice(4, 6), 16) / 255
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1
  if (![r, g, b, a].every((n) => Number.isFinite(n))) {
    throw new Error(`invalid hex color: ${hex}`)
  }
  return { r, g, b, a }
}

function oklabToLinearSrgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

function linearSrgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

function oklabToSrgb(L: number, a: number, b: number, alpha: number): Srgb {
  const lin = oklabToLinearSrgb(L, a, b)
  return {
    r: linearToSrgbChannel(lin.r),
    g: linearToSrgbChannel(lin.g),
    b: linearToSrgbChannel(lin.b),
    a: alpha,
  }
}

function srgbToOklab(color: Srgb): { L: number; a: number; b: number } {
  return linearSrgbToOklab(
    srgbChannelToLinear(color.r),
    srgbChannelToLinear(color.g),
    srgbChannelToLinear(color.b),
  )
}

function parseOklch(value: string): Srgb {
  const match = value
    .trim()
    .match(
      /^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?(?:\s*\/\s*([0-9.]+)(%?))?\s*\)$/i,
    )
  if (!match) throw new Error(`unsupported oklch() color: ${value}`)
  const Lraw = Number(match[1])
  const C = Number(match[3])
  const H = Number(match[4])
  const L = match[2] === '%' ? Lraw / 100 : Lraw
  let alpha = 1
  if (match[5] !== undefined) {
    const aRaw = Number(match[5])
    alpha = match[6] === '%' ? aRaw / 100 : aRaw
  }
  if (![L, C, H, alpha].every((n) => Number.isFinite(n))) {
    throw new Error(`invalid oklch() color: ${value}`)
  }
  const hue = (H * Math.PI) / 180
  return oklabToSrgb(L, C * Math.cos(hue), C * Math.sin(hue), alpha)
}

function splitTopLevelArgs(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(inner.slice(start).trim())
  return parts.filter((part) => part.length > 0)
}

function parseMixStop(stop: string): { color: Srgb; p: number | null } {
  const match = stop.match(/^(.*?)\s+([0-9.]+)%$/)
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { color: parseCssColor(match[1].trim()), p: Number(match[2]) / 100 }
  }
  return { color: parseCssColor(stop), p: null }
}

function parseColorMix(value: string): Srgb {
  const match = value.trim().match(/^color-mix\(\s*in\s+oklab\s*,\s*([\s\S]+)\)$/i)
  if (!match || match[1] === undefined) {
    throw new Error(`unsupported color-mix() (need in oklab): ${value}`)
  }
  const stops = splitTopLevelArgs(match[1]).map(parseMixStop)
  if (stops.length !== 2) {
    throw new Error(`color-mix() needs two stops: ${value}`)
  }
  const a = stops[0]
  const b = stops[1]
  if (a === undefined || b === undefined) {
    throw new Error(`color-mix() needs two stops: ${value}`)
  }
  let p = 0.5
  if (a.p !== null && b.p !== null) {
    const sum = a.p + b.p
    p = sum === 0 ? 0.5 : a.p / sum
  } else if (a.p !== null) p = a.p
  else if (b.p !== null) p = 1 - b.p
  const labA = srgbToOklab(a.color)
  const labB = srgbToOklab(b.color)
  const L = labA.L * p + labB.L * (1 - p)
  const ax = labA.a * p + labB.a * (1 - p)
  const bx = labA.b * p + labB.b * (1 - p)
  const alpha = a.color.a * p + b.color.a * (1 - p)
  return oklabToSrgb(L, ax, bx, alpha)
}

/**
 * `oklch(from <color> <L> c h)` — the relative form Clay uses for its button
 * slabs (`--cta-face`, `--danger-face`, and their lips). Only lightness is
 * pinned; `c` and `h` are inherited, and since OKLCH's chroma/hue are just
 * OKLab's `a`/`b` in polar form, inheriting both means `a` and `b` pass
 * through untouched. So this is a pure lightness swap on the base colour.
 *
 * Caveat: `oklabToSrgb` clamps per channel, while browsers gamut-map by
 * reducing chroma. The two agree closely at the lightness these tokens pin
 * (spot-checked against the live app: --danger-face reads 5.91:1 there and
 * 5.914:1 here on Clay dark; --cta-face 5.39 vs 5.44), but a token
 * that lands far outside sRGB would read slightly more saturated in this
 * harness than on screen.
 */
function parseRelativeOklch(value: string): Srgb {
  const match = value.trim().match(/^oklch\(\s*from\s+(.+?)\s+([0-9.]+)(%?)\s+c\s+h\s*\)$/i)
  if (!match) throw new Error(`unsupported relative oklch() color: ${value}`)
  const base = parseCssColor(match[1])
  const Lraw = Number(match[2])
  const L = match[3] === '%' ? Lraw / 100 : Lraw
  if (!Number.isFinite(L)) throw new Error(`invalid relative oklch() color: ${value}`)
  const lab = srgbToOklab(base)
  return oklabToSrgb(L, lab.a, lab.b, base.a)
}

function parseCssColor(value: string): Srgb {
  const v = value.trim()
  if (v.startsWith('#')) return parseHexColor(v)
  if (/^oklch\(\s*from\s/i.test(v)) return parseRelativeOklch(v)
  if (/^oklch\(/i.test(v)) return parseOklch(v)
  if (/^color-mix\(/i.test(v)) return parseColorMix(v)
  throw new Error(`unsupported color value: ${value}`)
}

function relativeLuminance(color: Srgb): number {
  return (
    0.2126 * srgbChannelToLinear(color.r) +
    0.7152 * srgbChannelToLinear(color.g) +
    0.0722 * srgbChannelToLinear(color.b)
  )
}

function wcagContrastRatio(a: Srgb, b: Srgb): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function compositeOver(fg: Srgb, bg: Srgb): Srgb {
  if (fg.a >= 1 - 1e-9) return { r: fg.r, g: fg.g, b: fg.b, a: 1 }
  const t = 1 - fg.a
  return {
    r: fg.r * fg.a + bg.r * t,
    g: fg.g * fg.a + bg.g * t,
    b: fg.b * fg.a + bg.b * t,
    a: 1,
  }
}

function tokenColor(tokens: Map<string, string>, name: string): Srgb {
  const raw = tokens.get(name)
  if (raw === undefined) {
    if (name === '--color-accent') return parseCssColor(DEFAULT_ACCENT_HEX)
    throw new Error(`missing token ${name}`)
  }
  const color = parseCssColor(resolveVars(raw, tokens))
  if (color.a >= 1 - 1e-9) return color
  if (name === '--color-app') return compositeOver(color, { r: 0, g: 0, b: 0, a: 1 })
  return compositeOver(color, tokenColor(tokens, '--color-app'))
}

function contrastOf(tokens: Map<string, string>, fgName: string, bgName: string): number {
  return wcagContrastRatio(tokenColor(tokens, fgName), tokenColor(tokens, bgName))
}

let css: string
/**
 * `css` with `/* … *\/` comments stripped.
 *
 * Needed for *negative* assertions ("this selector must not exist"): the file
 * documents other design systems in prose, so a bare regex over the raw source
 * matches selector-shaped text inside comments and fails on a file that is
 * actually correct. Positive assertions keep using `css` — a token mentioned
 * only in a comment would be a test bug, not something to hide.
 */
let cssCode: string
let darkBlock: string
let themeBlock: string
/** Signature `.dark { … }` body only — not the remainder of the file after the split. */
let signatureDarkBody: string
/** Signature `.dark.surface-soft { … }` body — lifted charcoal overlay. */
let signatureSoftBody: string
/** Combined bodies of exact `:root.ds-clean` / `:root.dark.ds-clean` token blocks. */
let cleanTokenBodies: string
/** Combined bodies of exact `:root.ds-clean` token blocks only (not the dark union). */
let cleanLightTokenBodies: string
/** Combined bodies of exact `:root.dark.ds-clean` token blocks only (not the light union). */
let cleanDarkTokenBodies: string
/** Every Clean rule body, including descendants (`:root.ds-clean .x`). */
let cleanRuleBodies: string
/** Combined bodies of exact `:root.ds-clay` / `:root.dark.ds-clay` token blocks. */
let clayTokenBodies: string
/** Combined bodies of exact `:root.ds-clay` token blocks only (not the dark union). */
let clayLightTokenBodies: string
/** Combined bodies of exact `:root.dark.ds-clay` token blocks only (not the light union). */
let clayDarkTokenBodies: string
/** Every Clay rule body, including descendants (`:root.ds-clay .x`). */
let clayRuleBodies: string
/** Combined bodies of exact `.dark.surface-lumen` token blocks (paint + radius/elev). */
let lumenTokenBodies: string
/** Alias of `lumenTokenBodies` — there is no shared non-dark Lumen block. */
let lumenDarkTokenBodies: string
/** Every Lumen rule body, including descendants (`.dark.surface-lumen .x`). */
let lumenRuleBodies: string
/** Cascaded custom properties per shipping surface, later blocks win. */
let tokensBySurface: Record<SurfaceId, Map<string, string>>

beforeAll(() => {
  css = readFileSync(resolve(__dirname, 'globals.css'), 'utf8')
  cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // Dark overrides live in the .dark { } block
  const parts = css.split(/\.dark\s*\{/)
  darkBlock = parts[1] ?? ''
  themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  // `:root.dark.ds-clean {` does not match `/\.dark\s*\{/` — keep that split
  // intact for Signature assertions, then take only the first balanced body.
  // The split consumes the `{`, so the remainder already starts inside the body.
  signatureDarkBody = firstRuleBody(cssCode.split(/\.dark\s*\{/)[1] ?? '')
  signatureSoftBody = firstRuleBody(cssCode.split(/\.dark\.surface-soft\s*\{/)[1] ?? '')
  const rules = extractTopLevelRules(cssCode)
  cleanTokenBodies = rules
    .filter((rule) => isCleanTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  cleanLightTokenBodies = rules
    .filter((rule) => isLightCleanTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  cleanDarkTokenBodies = rules
    .filter((rule) => isDarkCleanTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  cleanRuleBodies = rules
    .filter((rule) => mentionsDsClean(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayTokenBodies = rules
    .filter((rule) => isClayTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayLightTokenBodies = rules
    .filter((rule) => isLightClayTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayDarkTokenBodies = rules
    .filter((rule) => isDarkClayTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  clayRuleBodies = rules
    .filter((rule) => mentionsDsClay(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  lumenTokenBodies = rules
    .filter((rule) => isLumenTokenSelector(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  lumenDarkTokenBodies = lumenTokenBodies
  lumenRuleBodies = rules
    .filter((rule) => mentionsSurfaceLumen(rule.selector))
    .map((rule) => rule.body)
    .join('\n')
  tokensBySurface = {
    'signature-light': cascadeTokenMaps(themeBlock),
    'signature-dark': cascadeTokenMaps(themeBlock, signatureDarkBody),
    'signature-soft': cascadeTokenMaps(themeBlock, signatureDarkBody, signatureSoftBody),
    'clean-light': cascadeTokenMaps(themeBlock, cleanLightTokenBodies),
    'clean-dark': cascadeTokenMaps(
      themeBlock,
      signatureDarkBody,
      cleanLightTokenBodies,
      cleanDarkTokenBodies,
    ),
    'lumen-dark': cascadeTokenMaps(themeBlock, signatureDarkBody, lumenDarkTokenBodies),
    'clay-light': cascadeTokenMaps(themeBlock, clayLightTokenBodies),
    'clay-dark': cascadeTokenMaps(
      themeBlock,
      signatureDarkBody,
      clayLightTokenBodies,
      clayDarkTokenBodies,
    ),
  }
})

describe('Dark mode mechanism', () => {
  it('uses @custom-variant dark wired to .dark class (not [data-theme])', () => {
    expect(css).toMatch(/@custom-variant\s+dark/)
    expect(css).toContain('.dark')
  })

  it('does NOT have a [data-theme="dark"] block', () => {
    // Comments stripped: globals.css references another design system's
    // `[data-theme='dark']` in prose, which is documentation, not a selector.
    expect(cssCode).not.toMatch(/\[data-theme=['"]dark['"]\]/)
  })
})

describe('Semantic OKLCH tokens — registered in @theme', () => {
  it.each([
    '--color-app',
    '--color-panel-1',
    '--color-panel-2',
    '--color-panel-3',
    '--color-elevated',
    '--color-chrome',
    '--color-fg',
    '--color-fg-secondary',
    '--color-fg-muted',
    '--color-fg-inverse',
    '--color-surface-hi',
    '--color-border-subtle',
    '--color-border-default',
    '--color-border-strong',
    '--color-accent',
    '--color-accent-hover',
    '--color-accent-soft',
    '--color-accent-text',
    '--color-focus-ring',
    '--color-danger',
    '--color-success',
    '--color-warning',
    '--color-info',
    '--color-empty',
    '--color-warning-bg',
    '--color-warning-border',
    '--color-warning-fg',
    '--color-danger-bg',
    '--color-danger-border',
    '--color-danger-fg',
  ])('@theme defines %s', (token) => {
    expect(themeBlock).toContain(token)
  })

  it('uses SuperX hex surfaces, text, and Sky accent in @theme (light)', () => {
    expect(themeBlock).toMatch(/--color-app:\s*#f4f3f1/)
    expect(themeBlock).toMatch(/--color-fg:\s*#1a1917/)
    expect(themeBlock).toMatch(/--color-accent:\s*oklch\(55% 0\.18 230\)/)
    expect(themeBlock).toMatch(/--color-accent-fill:\s*oklch\(53% 0\.2 230\)/)
    expect(themeBlock).toMatch(/--color-border-subtle:\s*#e5e2d9/)
    expect(themeBlock).toMatch(/--color-border-default:\s*#dddddd/)
    expect(themeBlock).toMatch(/--color-border-strong:\s*#c7c3bf/)
  })
})

describe('SuperX dark charcoal ladder', () => {
  it('maps SuperX surface layers onto semantic tokens', () => {
    expect(darkBlock).toMatch(/--color-app:\s*#0d0d0d/)
    expect(darkBlock).toMatch(/--color-panel-1:\s*#141414/)
    expect(darkBlock).toMatch(/--color-elevated:\s*#1c1c1c/)
    expect(darkBlock).toMatch(/--color-chrome:\s*#0a0a0a/)
    expect(darkBlock).toMatch(/--color-surface-hi:\s*#242424/)
  })

  it('uses SuperX warm-stone text + solid borders + Sky accent', () => {
    // App chrome fg; editor body max is pure white (see ProseMirror override).
    expect(darkBlock).toMatch(/--color-fg:\s*#eee/)
    expect(darkBlock).toMatch(/--color-fg-muted:\s*#a8a29e/)
    expect(darkBlock).toMatch(/--color-border-subtle:\s*#2a2a2a/)
    expect(darkBlock).toMatch(/--color-border-default:\s*#363636/)
    expect(darkBlock).toMatch(/--color-border-strong:\s*#4a4a4a/)
    expect(darkBlock).toMatch(/--color-accent:\s*oklch\(72% 0\.15 230\)/)
  })

  it('sets dark editor body max fg to pure white for contrast headroom', () => {
    expect(css).toMatch(/\.dark\s+\.ProseMirror\s*\{[^}]*--color-fg:\s*#ffffff/s)
  })
})

describe('Dark mode redefines all semantic tokens', () => {
  it.each([
    '--color-app',
    '--color-panel-1',
    '--color-panel-2',
    '--color-panel-3',
    '--color-elevated',
    '--color-chrome',
    '--color-fg',
    '--color-fg-secondary',
    '--color-fg-muted',
    '--color-fg-inverse',
    '--color-surface-hi',
    '--color-border-subtle',
    '--color-border-default',
    '--color-border-strong',
    '--color-accent',
    '--color-accent-soft',
    '--color-accent-text',
    '--color-focus-ring',
  ])('dark block redefines %s', (token) => {
    expect(darkBlock).toContain(token)
  })
})

describe('Glass tokens removed — toast uses semantic color tokens', () => {
  it.each(['--glass-bg-strong', '--glass-border'])(
    'does NOT define %s (removed in Phase 3 Task 2)',
    (token) => {
      expect(css).not.toContain(token)
    },
  )
})

describe('Removed glass utility classes — replaced by Tailwind', () => {
  it.each([
    '@utility glass-bg',
    '@utility glass-bg-strong',
    '@utility glass-bg-subtle',
    '@utility glass-bg-chrome',
    '@utility glass-bg-sidebar',
    '@utility glass-border',
    '@utility glass-border-subtle',
    '@utility glass-blur-xs',
    '@utility glass-blur-sm',
    '@utility glass-blur-md',
    '@utility glass-blur-lg',
    '@utility shadow-elev-1',
    '@utility shadow-elev-2',
    '@utility shadow-elev-3',
    '@utility shadow-elev-4',
    '@utility canvas-surface',
  ])('does NOT define %s', (rule) => {
    expect(css).not.toContain(rule)
  })
})

describe('Removed dead CSS vars — replaced by Tailwind classes', () => {
  it.each([
    // '--text-xs', '--text-sm', '--text-base' are intentionally re-introduced
    // in @theme — bumped/scaled by --ui-font-scale and --ds-type-scale (see
    // the "Typography token overrides" suite).
    '--leading-tight',
    '--leading-normal',
    '--space-1',
    '--space-4',
    // `--radius-xs`…`--radius-xl` are retuned under `:root.ds-clean` (Clean
    // Task 3) so they are no longer globally absent. `--radius-pill` was
    // never part of that ladder.
    '--radius-pill',
    '--hairline:',
    '--hairline-xstrong',
    '--glass-bg:',
    '--glass-bg-subtle',
    '--glass-bg-chrome',
    '--glass-bg-sidebar',
    '--glass-border-subtle',
    '--blur-xs',
    '--blur-sm',
    '--blur-md',
    '--blur-lg',
    '--scrim-bg',
    '--sidebar-width',
    '--editor-max-width',
    '--entry-list-width',
  ])('no longer defines %s', (token) => {
    expect(css).not.toContain(token)
  })
})

describe('Typography token overrides', () => {
  it('@theme bumps --text-xs to 0.8125rem (13px), scaled by --ui-font-scale and --ds-type-scale', () => {
    expect(themeBlock).toMatch(
      /--text-xs:\s*calc\(0\.8125rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\);/,
    )
  })

  it('@theme scales the UI body text ladder (2xs → base) by --ui-font-scale and --ds-type-scale', () => {
    expect(themeBlock).toMatch(
      /--text-2xs:\s*calc\(0\.75rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\);/,
    )
    expect(themeBlock).toMatch(
      /--text-sm:\s*calc\(0\.875rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\);/,
    )
    expect(themeBlock).toMatch(
      /--text-base:\s*calc\(1rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\);/,
    )
  })

  it(':root defaults --ds-type-scale to 1; Clay overrides to 1.06', () => {
    expect(css).toMatch(/--ds-type-scale:\s*1;/)
    expect(css).toMatch(
      /--ui-icon-size:\s*calc\(1rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\);/,
    )
    expect(clayLightTokenBodies).toMatch(/--ds-type-scale:\s*1\.06/)
  })

  it('pins the shared html root to 16px (all three skins scale off it)', () => {
    const htmlRule = css.match(/\nhtml\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(htmlRule).toMatch(/font-size:\s*16px;/)
  })

  it('Clay collapses xs onto sm — its ladder is not the Signature/Clean one', () => {
    expect(clayLightTokenBodies).toMatch(/--text-2xs:\s*calc\(0\.75rem\s*\*/)
    expect(clayLightTokenBodies).toMatch(/--text-xs:\s*calc\(0\.875rem\s*\*/)
    expect(clayLightTokenBodies).toMatch(/--text-sm:\s*calc\(0\.875rem\s*\*/)
    expect(clayLightTokenBodies).toMatch(/--text-base:\s*calc\(1rem\s*\*/)
  })

  it('floors --text-lg at --text-base so the ladder cannot invert', () => {
    // Clay at Interface size 1.1 puts base at 18.66px, above the unscaled
    // 18px heading step — the `max()` keeps them equal instead of inverted.
    expect(css).toMatch(/--text-lg:\s*max\(1\.125rem,\s*var\(--text-base\)\);/)
  })
})

describe('Gradients & primary glow', () => {
  it.each(['--grad-primary', '--grad-accent-soft', '--shadow-primary-glow'])(
    'defines %s',
    (token) => {
      expect(css).toContain(token)
    },
  )

  it('Phase C — does NOT define --grad-gold (gold gradient dropped)', () => {
    expect(css).not.toMatch(/--grad-gold\s*:/)
    expect(css).not.toContain('@utility gradient-gold')
  })
})

describe('4-level elevation scale', () => {
  it.each(['--elev-1', '--elev-2', '--elev-3', '--elev-4'])('defines %s', (token) => {
    expect(css).toContain(token)
  })
})

describe('Titlebar and graphite backdrop (Phase 3 — blobs removed)', () => {
  it.each(['--titlebar-bg', '--titlebar-edge'])(
    'does NOT define %s (removed in Phase 3 Task 2 — TitleBar uses bg-chrome + border-b)',
    (token) => {
      expect(css).not.toContain(token)
    },
  )

  it('removes blob token definitions', () => {
    expect(css).not.toContain('--blob-1')
    expect(css).not.toContain('--blob-2')
    expect(css).not.toContain('--blob-3')
  })

  it('removes blob drift keyframe animations', () => {
    expect(css).not.toMatch(/@keyframes\s+blobDrift1/)
    expect(css).not.toMatch(/@keyframes\s+blobDrift2/)
    expect(css).not.toMatch(/@keyframes\s+blobDrift3/)
  })

  it('removes .xj-blob child element selector', () => {
    expect(css).not.toMatch(/\.xj-root\s*>\s*\.xj-blob/)
    expect(css).not.toMatch(/\.xj-blob/)
  })

  it('preserves .xj-root with overflow:clip and flex-column layout', () => {
    expect(css).toMatch(/\.xj-root\s*\{[^}]*overflow:\s*clip/)
    expect(css).toMatch(/\.xj-root\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.xj-root\s*\{[^}]*flex-direction:\s*column/)
  })

  it('keeps a static ::before glow on .xj-root (no animation)', () => {
    expect(css).toMatch(/\.xj-root::before/)
    // Signature glow — not the Clean `:root.ds-clean .xj-root::before` flatten,
    // which appears first and only sets `display: none`.
    const beforeBlock = css.match(/(?:^|\n)\.xj-root::before\s*\{[^}]*\}/)
    expect(beforeBlock).not.toBeNull()
    expect(beforeBlock![0]).not.toMatch(/animation/)
    expect(beforeBlock![0]).toContain('pointer-events: none')
  })

  it('stops all animation under prefers-reduced-motion', () => {
    const reducedBlock = css.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\n\}/,
    )
    expect(reducedBlock).not.toBeNull()
    // General kill-switch must be present
    expect(reducedBlock![0]).toMatch(/\*\s*\{[^}]*animation:\s*none/)
  })

  it('places the empty editor placeholder on the right in RTL writing mode', () => {
    expect(css).toMatch(
      /\[dir='rtl'\]\s+\.ProseMirror p\.is-editor-empty:first-child::before,[\s\S]*?float:\s*right/,
    )
  })

  it('uses logical table alignment so cells follow the writing direction', () => {
    expect(css).toMatch(/\.ProseMirror th,[\s\S]*?\.ProseMirror td\s*\{[^}]*text-align:\s*start/)
  })
})

describe('Plain color vars are gone (replaced by semantic OKLCH tokens)', () => {
  it.each([
    '--bg:',
    '--bg-deeper:',
    '--surface:',
    '--surface-warm:',
    '--editor-bg:',
    '--text:',
    '--text-muted:',
    '--text-faint:',
    '--violet:',
    '--violet-deep:',
    '--fuchsia:',
    '--blue:',
    '--green:',
    '--amber:',
    '--red:',
    '--gold:',
    '--gold-deep:',
    '--accent-tint:',
    '--red-tint:',
  ])('no longer defines %s as a CSS custom property', (token) => {
    expect(css).not.toContain(token)
  })
})

describe('Motion tokens', () => {
  it.each(['--motion-fast', '--motion-base', '--motion-slow', '--motion-spring'])(
    'defines %s',
    (token) => {
      expect(css).toContain(token)
    },
  )
})

describe('Tailwind v4 utilities', () => {
  it.each([
    '@utility gradient-primary',
    '@utility gradient-accent-soft',
    '@utility shadow-primary-glow',
    '@utility shadow-destructive-glow',
    '@utility card-glow',
    '@utility card-glow-inner',
    '@utility no-scrollbar',
  ])('declares %s', (rule) => {
    expect(css).toContain(rule)
  })

  it('Phase C — gradient-gold utility was removed', () => {
    expect(css).not.toContain('@utility gradient-gold')
  })

  it('paints gradient-primary from the AA-safe CTA gradient token', () => {
    expect(css).toMatch(/@utility gradient-primary\s*\{\s*background:\s*var\(--grad-accent-fill\)/)
    expect(css).toMatch(
      /@utility gradient-accent-soft\s*\{\s*background:\s*var\(--grad-accent-soft\)/,
    )
  })

  it('Signature pins .gradient-primary to --grad-accent-fill at (0,3,0)', () => {
    expect(css).toMatch(
      /:root\.ds-signature\s+\.gradient-primary\s*\{[^}]*background:\s*var\(--grad-accent-fill\)/,
    )
  })

  it('Clay pins .gradient-primary to --grad-accent-fill (convex, not flat)', () => {
    expect(css).toMatch(
      /:root\.ds-clay\s+\.gradient-primary\s*\{[^}]*background:\s*var\(--grad-accent-fill\)/,
    )
    expect(css).not.toMatch(
      /:root\.ds-clay\s+\.gradient-primary\s*\{[^}]*background:\s*var\(--color-accent-fill\)/,
    )
  })

  it('Clay CTA label: the primary button is white ink, other accent fills keep the accent ink', () => {
    expect(css).not.toMatch(/:root\.ds-clay\s+\.gradient-primary\s*\{[^}]*color:/)
    // Every accent slab that carries a label now uses the CTA face + ink; the
    // dark accent-ink rule is left only for the generic .gradient-primary fill.
    expect(css).toMatch(
      /:root\.dark\.ds-clay\s+\.gradient-primary:not\(button\[data-variant='primary'\]\)\s*\{[^}]*color:\s*var\(--color-accent-ink\)/,
    )
    expect(css).toMatch(
      /:root\.ds-clay\s+button\[data-variant='primary'\]\s*\{[^}]*color:\s*var\(--cta-ink\)/,
    )
    expect(clayTokenBodies).toMatch(/--cta-ink:\s*#ffffff/)
  })

  it('Clay slabs carry no negative-offset inner shade (it left a light hairline)', () => {
    expect(clayTokenBodies).not.toMatch(/inset 0 -\d+px/)
    expect(css).not.toMatch(
      /:root\.ds-clay\s+button\[data-variant='primary'\]\s*\{[^}]*box-shadow:[^;]*inset/,
    )
  })

  it('Clay danger slab is the CTA construction in danger colours, white ink', () => {
    expect(clayTokenBodies).toMatch(/--danger-face:\s*oklch\(from var\(--color-danger-fill\) 0\.52/)
    expect(clayTokenBodies).toMatch(/--danger-lip:\s*oklch\(from var\(--color-danger-fill\) 0\.34/)
    expect(css).toMatch(
      /:root\.ds-clay\s+button\[data-variant='destructive'\]\s*\{[^}]*background:\s*var\(--danger-face\)[^}]*color:\s*var\(--cta-ink\)[^}]*0 var\(--rise\) 0 0 var\(--danger-lip\)/,
    )
  })

  it('Clay CTA face and lip are distinct accent-derived slabs', () => {
    expect(clayTokenBodies).toMatch(/--cta-face:\s*oklch\(from var\(--color-accent-fill\) 0\.52/)
    expect(clayTokenBodies).toMatch(/--cta-lip:\s*oklch\(from var\(--color-accent-fill\) 0\.34/)
    expect(css).toMatch(
      /:root\.ds-clay\s+button\[data-variant='primary'\]\s*\{[^}]*background:\s*var\(--cta-face\)[^}]*0 var\(--rise\) 0 0 var\(--cta-lip\)/,
    )
  })

  it('leaves --shadow-cta none on shared :root so Signature/Clean stay flat', () => {
    expect(cssCode).toMatch(/:root\s*\{[^}]*--shadow-cta:\s*none/)
    expect(cssCode).toMatch(/:root\s*\{[^}]*--shadow-cta-pressed:\s*none/)
    expect(cleanTokenBodies).not.toContain('--shadow-cta:')
    expect(cleanTokenBodies).not.toContain('--shadow-cta-pressed:')
  })

  it('leaves --shadow-panel none on shared :root so Signature/Clean stay flat', () => {
    expect(cssCode).toMatch(/:root\s*\{[^}]*--shadow-panel:\s*none/)
    expect(cleanTokenBodies).not.toContain('--shadow-panel:')
  })

  it('leaves --shadow-card none on shared :root so Signature/Clean stay flat', () => {
    expect(cssCode).toMatch(/:root\s*\{[^}]*--shadow-card:\s*none/)
    expect(cleanTokenBodies).not.toContain('--shadow-card:')
  })

  it('leaves --shadow-control none on shared :root so Signature/Clean stay flat', () => {
    expect(cssCode).toMatch(/:root\s*\{[^}]*--shadow-control:\s*none/)
    expect(cssCode).toMatch(/:root\s*\{[^}]*--shadow-toggle-on:\s*none/)
    expect(cleanTokenBodies).not.toContain('--shadow-control:')
    expect(cleanTokenBodies).not.toContain('--shadow-toggle-on:')
  })

  it('glow utilities layer --elev-2 under the halo so both remain visible', () => {
    expect(css).toMatch(
      /@utility shadow-primary-glow\s*\{\s*box-shadow:\s*var\(--elev-2\),\s*var\(--shadow-primary-glow\)/,
    )
    expect(css).toMatch(
      /@utility shadow-destructive-glow\s*\{\s*box-shadow:\s*var\(--elev-2\),\s*var\(--shadow-destructive-glow\)/,
    )
  })

  it('Signature light flattens card-glow to a hairline + white fill, no drop shadow', () => {
    expect(css).toMatch(
      /:root\.ds-signature:not\(\.dark\)\s+\.card-glow\s*\{\s*background:\s*var\(--color-border-default\);\s*box-shadow:\s*none;/,
    )
    expect(css).toMatch(
      /:root\.ds-signature:not\(\.dark\)\s+\.card-glow-inner\s*\{\s*background:\s*var\(--color-elevated\);/,
    )
  })

  it('does NOT redefine Tailwind built-in blur-* utilities (avoids collision)', () => {
    expect(css).not.toMatch(/^@utility blur-(xs|sm|md|lg)\b/m)
  })
})

describe('Body rule', () => {
  it('uses semantic --color-app + --color-fg tokens (not theme(colors.*) literals)', () => {
    const bodyRule = css.match(/\bbody\s*\{[^}]*\}/)
    expect(bodyRule).not.toBeNull()
    expect(bodyRule![0]).toContain('var(--color-app)')
    expect(bodyRule![0]).toContain('var(--color-fg)')
    expect(bodyRule![0]).not.toContain('theme(colors.violet')
    expect(bodyRule![0]).not.toContain('theme(colors.slate')
  })

  it('body uses numeric line-height (not var(--leading-normal))', () => {
    const bodyRule = css.match(/\bbody\s*\{[^}]*\}/)
    expect(bodyRule).not.toBeNull()
    expect(bodyRule![0]).toContain('line-height: 1.5')
    expect(bodyRule![0]).not.toContain('var(--leading')
  })
})

describe('Fonts — self-hosted, no network (offline regression guard)', () => {
  it('does NOT reference Google Fonts (or any external font URL) — fonts are bundled offline', () => {
    // The whole point: no runtime CDN request for typography. Fonts are
    // self-hosted via @fontsource packages imported in src/main.tsx.
    expect(css).not.toContain('fonts.googleapis.com')
    expect(css).not.toContain('fonts.gstatic.com')
    expect(css).not.toMatch(/@import\s+url\(['"]https?:\/\//)
  })

  it('--font-display is the self-hosted Geist Variable family', () => {
    expect(themeBlock).toMatch(/--font-display\s*:[^;]*Geist Variable/)
  })

  it('--font-title is the self-hosted Fraunces Variable family (app wordmark + entry titles)', () => {
    expect(themeBlock).toMatch(/--font-title\s*:[^;]*Fraunces Variable/)
  })

  it('--font-display is not Nunito (Nunito stays a user-selectable editor font only)', () => {
    expect(themeBlock).not.toMatch(/--font-display\s*:[^;]*Nunito/)
  })

  it('mono stack is the self-hosted Geist Mono Variable family', () => {
    expect(css).toMatch(/--font-mono\s*:[^;]*Geist Mono Variable/)
  })
})

describe('Font display token — @theme utility', () => {
  it('defines @theme block with --font-display token for Tailwind v4 utility generation', () => {
    expect(themeBlock).toContain('--font-display')
  })

  it('renames --font-heading to --font-display (--font-heading must not appear anywhere)', () => {
    expect(css).not.toContain('--font-heading')
  })

  it('Phase 1 graphite — --font-display points at Geist (replaced Fraunces, not Nunito)', () => {
    expect(themeBlock).toMatch(/--font-display\s*:[^;]*Geist/)
    expect(themeBlock).not.toContain('Nunito')
  })
})

describe('M7 cleanup — clay aliases removed (still enforced)', () => {
  it.each([
    '@utility shadow-clay-card',
    '@utility shadow-clay-button',
    '@utility shadow-clay-pressed',
    '@utility shadow-clay-deep',
    '@utility animate-clay-float',
    '@utility animate-clay-float-delayed',
    '@utility animate-clay-breathe',
  ])('does NOT define deprecated %s', (rule) => {
    expect(css).not.toContain(rule)
  })

  it.each([
    '--shadow-clay-card',
    '--shadow-clay-button',
    '--shadow-clay-pressed',
    '--shadow-clay-deep',
    '--radius-card:',
    '--radius-button:',
    '--radius-input:',
    '--radius-container:',
    '--color-card-bg:',
    '--color-bg-sidebar',
    '--color-text-primary',
    '--transition-base',
  ])('does NOT define deprecated %s custom property', (token) => {
    expect(css).not.toContain(token)
  })

  it('does NOT keep the clay-float @keyframes block', () => {
    expect(css).not.toMatch(/@keyframes\s+clay-float/)
  })
})

describe('Accessibility', () => {
  it('supports prefers-reduced-motion', () => {
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/)
  })

  it('defines a JS-driven .reduce-motion class as a parallel path', () => {
    expect(css).toMatch(/\.reduce-motion\s*\*\s*\{/)
  })

  it('draws an instant :focus-visible ring from --color-focus-ring', () => {
    // Anchored to the BARE `:focus-visible` rule (start of line) — a compound
    // selector like `input:focus-visible` must not satisfy this assertion.
    expect(css).toMatch(
      /(?:^|\n):focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--color-focus-ring\)/,
    )
    expect(css).toMatch(/(?:^|\n):focus-visible\s*\{[^}]*outline-offset:\s*2px/)
    // Must not globally kill the ring (WebKit default suppression lives elsewhere).
    expect(css).not.toMatch(/(?:^|\n):focus-visible\s*\{[^}]*outline:\s*none/)
  })

  it('does not wrap the ProseMirror canvas in the global focus ring', () => {
    expect(css).toMatch(/\.ProseMirror:focus-visible\s*\{[^}]*outline:\s*none/)
  })

  it('does not wrap text fields in the global focus ring', () => {
    expect(css).toMatch(
      /input:not\([\s\S]*?\)\:focus-visible[\s\S]*?textarea:focus-visible\s*\{[^}]*outline:\s*none/,
    )
    expect(css).not.toMatch(/select:focus-visible\s*\{[^}]*outline:\s*none/)
  })
})

describe('t-shimmer text effect', () => {
  it('defines .t-shimmer with a ::before highlight driven by data-text', () => {
    expect(css).toMatch(/\.t-shimmer\s*\{/)
    expect(css).toMatch(/\.t-shimmer::before\s*\{[\s\S]*?content:\s*attr\(data-text\)/)
    expect(css).toMatch(/@keyframes\s+t-shimmer/)
  })

  it('exposes shimmer tokens derived from --color-fg (not hardcoded ink)', () => {
    expect(css).toMatch(
      /\.t-shimmer\s*\{[\s\S]*?--shimmer-base:\s*color-mix\([^;]*var\(--color-fg\)/,
    )
    expect(css).toMatch(/\.t-shimmer\s*\{[\s\S]*?--shimmer-highlight:\s*var\(--color-fg\)/)
    expect(css).not.toMatch(/\.t-shimmer\s*\{[\s\S]*?rgba\(7,\s*7,\s*7/)
  })

  it('uses the highlight token in the ::before gradient (not a hard-coded single-theme color)', () => {
    expect(css).toMatch(/\.t-shimmer::before\s*\{[\s\S]*?var\(--shimmer-highlight\)/)
  })

  it('does NOT keep the superseded animate-shimmer utility', () => {
    expect(cssCode).not.toMatch(/@utility\s+animate-shimmer/)
    expect(cssCode).not.toMatch(/@keyframes\s+xj-shimmer/)
  })
})

describe('Clean design system — :root.ds-clean / :root.dark.ds-clean', () => {
  it('redefines every Signature .dark token except the inline-only allowlist', () => {
    const darkTokens = customPropertyNames(signatureDarkBody)
    expect(darkTokens.length).toBeGreaterThan(40)

    const allowlistNotInDark = CLEAN_INLINE_ONLY_TOKENS.filter(
      (token) => !darkTokens.includes(token),
    )
    expect(allowlistNotInDark).toEqual([])

    const missing = darkTokens.filter(
      (name) => !CLEAN_INLINE_ONLY_TOKEN_SET.has(name) && !cleanTokenBodies.includes(`${name}:`),
    )
    expect(missing).toEqual([])
  })

  // Union-parity can pass on `:root.ds-clean` alone — that light block already
  // names every `.dark` color token. html.dark.ds-clean would then paint light
  // neutrals: `:root.ds-clean` is (0,2,0) and beats `.dark` (0,1,0).
  it('redefines color, status, border, and content-grad tokens on :root.dark.ds-clean itself', () => {
    expect(cleanDarkTokenBodies.trim().length).toBeGreaterThan(0)
    expect(cleanDarkTokenBodies).toContain('--color-app:')

    const paintTokens = customPropertyNames(signatureDarkBody).filter(
      (name) => !CLEAN_INLINE_ONLY_TOKEN_SET.has(name) && isCleanPaintToken(name),
    )
    expect(paintTokens.length).toBeGreaterThan(0)

    const missing = paintTokens.filter((name) => !cleanDarkTokenBodies.includes(`${name}:`))
    expect(missing).toEqual([])
  })

  it('locks --color-app, --color-fg, and --color-border-default to the Clean dark ladder', () => {
    expect(cleanDarkTokenBodies).toMatch(/--color-app:\s*oklch\(0\.09 0 0\)/)
    expect(cleanDarkTokenBodies).toMatch(/--color-fg:\s*oklch\(0\.985 0 0\)/)
    expect(cleanDarkTokenBodies).toMatch(/--color-border-default:\s*oklch\(1 0 0 \/ 12%\)/)
  })

  it('lifts Clean dark elevated above panel-1 so cards read as a plane', () => {
    expect(cleanDarkTokenBodies).toMatch(/--color-elevated:\s*oklch\(0\.245 0 0\)/)
    expect(cleanDarkTokenBodies).toMatch(/--color-panel-1:\s*oklch\(0\.205 0 0\)/)
  })

  it('does not override --font-title so titles stay Fraunces Variable', () => {
    expect(cleanTokenBodies).not.toContain('--font-title:')
  })

  it('every --color-* referenced by a Clean value is defined in globals.css', () => {
    const referenced = new Set<string>()
    for (const match of cleanRuleBodies.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      if (match[1] !== undefined) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(0)

    const defined = new Set(
      customPropertyNames(cssCode).filter((name) => name.startsWith('--color-')),
    )
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('does not use a bare .ds-clean or .dark.ds-clean selector', () => {
    const illegal: string[] = []
    for (const match of cssCode.matchAll(/\.ds-clean(?![a-z0-9-])/g)) {
      const prefix = cssCode.slice(0, match.index)
      if (!prefix.endsWith(':root') && !prefix.endsWith(':root.dark')) {
        const from = Math.max(0, match.index - 24)
        illegal.push(cssCode.slice(from, match.index + '.ds-clean'.length).trim())
      }
    }
    expect(illegal).toEqual([])
  })

  it('places the first :root.ds-clean block after the last .dark.surface-soft block', () => {
    const lastSoft = lastMatchIndex(cssCode, /\.dark\.surface-soft\s*\{/)
    const firstClean = cssCode.search(/:root\.ds-clean\s*\{/)
    expect(lastSoft).toBeGreaterThan(-1)
    expect(firstClean).toBeGreaterThan(-1)
    expect(firstClean).toBeGreaterThan(lastSoft)
  })

  it.each(['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'])(
    'does not define %s outside Clean or Lumen (Signature keeps Tailwind defaults)',
    (token) => {
      const signatureBodies = extractTopLevelRules(cssCode)
        .filter(
          (rule) =>
            !mentionsDsClean(rule.selector) &&
            !mentionsDsClay(rule.selector) &&
            !mentionsSurfaceLumen(rule.selector),
        )
        .map((rule) => rule.body)
        .join('\n')
      expect(signatureBodies).not.toContain(`${token}:`)
    },
  )

  it('corner-radius sweep remaps rounded-sm/md/lg/xl buttons except .media-tap-placeholder', () => {
    const sweep = cssCode.match(
      /:root\.ds-clean:is\(\.rad-medium,\s*\.rad-high\)[\s\S]*?border-radius:\s*var\(--button-radius\)/,
    )
    expect(sweep).not.toBeNull()
    const selector = sweep![0]
    expect(selector).toContain("class~='rounded-sm'")
    expect(selector).toContain("class~='rounded-xl'")
    expect(selector).toContain('.media-tap-placeholder')
  })
})

describe('Signature Lumen surface — .dark.surface-lumen', () => {
  it('defines a dark paint block with --color-app', () => {
    expect(lumenDarkTokenBodies.trim().length).toBeGreaterThan(0)
    expect(lumenDarkTokenBodies).toContain('--color-app:')
  })

  it('locks --color-app and --color-fg on .dark.surface-lumen', () => {
    expect(lumenDarkTokenBodies).toMatch(/--color-app:\s*oklch\(13% 0\.014 265\)/)
    expect(lumenDarkTokenBodies).toMatch(/--color-fg:\s*oklch\(96% 0\.006 262\)/)
  })

  it('omits --color-accent so first paint inherits Signature .dark until applyAccent', () => {
    expect(lumenDarkTokenBodies).not.toContain('--color-accent:')
    expect(lumenDarkTokenBodies).not.toContain('--color-accent-fill:')
  })

  it('does not override --font-title or --button-radius', () => {
    expect(lumenTokenBodies).not.toContain('--font-title:')
    expect(lumenTokenBodies).not.toContain('--button-radius:')
  })

  it('does not introduce Instrument Serif or JetBrains Mono', () => {
    expect(lumenRuleBodies).not.toMatch(/Instrument Serif/)
    expect(lumenRuleBodies).not.toMatch(/JetBrains Mono/)
  })

  it('every --color-* referenced by a Lumen value is defined in globals.css', () => {
    const referenced = new Set<string>()
    for (const match of lumenRuleBodies.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      if (match[1] !== undefined) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(0)

    const defined = new Set(
      customPropertyNames(cssCode).filter((name) => name.startsWith('--color-')),
    )
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('has zero ds-lumen identifiers', () => {
    expect(css).not.toContain('ds-lumen')
  })

  it('does not declare @custom-variant surface-lumen or a light Lumen block', () => {
    expect(cssCode).not.toMatch(/@custom-variant\s+surface-lumen/)
    const lumenSelectors = extractTopLevelRules(cssCode)
      .filter((rule) => mentionsSurfaceLumen(rule.selector))
      .map((rule) => rule.selector)
    expect(lumenSelectors.length).toBeGreaterThan(0)
    expect(lumenSelectors.every((selector) => selector.startsWith('.dark.surface-lumen'))).toBe(
      true,
    )
  })

  it('places the first .dark.surface-lumen block after the last .dark.surface-soft and before the first Clean block', () => {
    const lastSoft = lastMatchIndex(cssCode, /\.dark\.surface-soft\s*\{/)
    const firstLumen = cssCode.search(/\.dark\.surface-lumen\s*\{/)
    const firstClean = cssCode.search(/:root\.ds-clean\s*\{/)
    expect(lastSoft).toBeGreaterThan(-1)
    expect(firstLumen).toBeGreaterThan(-1)
    expect(firstClean).toBeGreaterThan(-1)
    expect(firstLumen).toBeGreaterThan(lastSoft)
    expect(firstClean).toBeGreaterThan(firstLumen)
  })

  it('paints a static blueprint grid on .xj-root::before', () => {
    const block = cssCode.match(/\.dark\.surface-lumen\s+\.xj-root::before\s*\{[^}]*\}/)
    expect(block).not.toBeNull()
    expect(block![0]).toContain('repeating-linear-gradient')
    expect(block![0]).not.toMatch(/animation/)
  })
})

describe('Clay design system — :root.ds-clay / :root.dark.ds-clay', () => {
  it('defines the same paint token set Clean defines on light and dark', () => {
    expect(clayLightTokenBodies.trim().length).toBeGreaterThan(0)
    expect(clayDarkTokenBodies.trim().length).toBeGreaterThan(0)
    expect(clayTokenBodies).toContain('--color-app:')

    const cleanLightPaint = customPropertyNames(cleanLightTokenBodies).filter(isCleanPaintToken)
    const cleanDarkPaint = customPropertyNames(cleanDarkTokenBodies).filter(isCleanPaintToken)
    expect(cleanLightPaint.length).toBeGreaterThan(0)
    expect(cleanDarkPaint.length).toBeGreaterThan(0)

    const missingLight = cleanLightPaint.filter(
      (name) => !clayLightTokenBodies.includes(`${name}:`),
    )
    const missingDark = cleanDarkPaint.filter((name) => !clayDarkTokenBodies.includes(`${name}:`))
    expect(missingLight).toEqual([])
    expect(missingDark).toEqual([])
  })

  // Union-parity can pass on `:root.ds-clay` alone — that light block already
  // names these. html.dark.ds-clay would then paint light values:
  // `:root.ds-clay` is (0,2,0) and beats `.dark` (0,1,0). isCleanPaintToken
  // is color + content-grad only, so elev / nav-active / hairline / idle-bg
  // would not be caught.
  it('redefines inherit-prone tokens on :root.dark.ds-clay itself', () => {
    expect(clayDarkTokenBodies.trim().length).toBeGreaterThan(0)

    const inheritProne = [
      '--elev-1',
      '--elev-2',
      '--elev-3',
      '--elev-4',
      '--shadow-cta',
      '--shadow-cta-pressed',
      '--shadow-panel',
      '--shadow-card',
      '--shadow-control',
      '--slab-deep',
      '--shadow-toggle-on',
      '--grad-surface',
      '--nav-active-bg',
      '--nav-hover-bg',
      '--nav-rail-active-bg',
      '--nav-rail-hover-bg',
      '--hairline-strong',
      '--entry-card-idle-bg',
    ]
    const missing = inheritProne.filter((name) => !clayDarkTokenBodies.includes(`${name}:`))
    expect(missing).toEqual([])
  })

  it('locks --color-app, --color-fg, and --color-border-default to the Clay light ladder', () => {
    expect(clayLightTokenBodies).toMatch(/--color-app:\s*#ebe3d6/)
    expect(clayLightTokenBodies).toMatch(/--color-fg:\s*#2a241c/)
    expect(clayLightTokenBodies).toMatch(/--color-border-default:\s*#2a241c1a/)
    expect(clayLightTokenBodies).toMatch(/--color-surface-hi:\s*#f7f1e6/)
    expect(clayLightTokenBodies).toMatch(
      /--entry-card-hover-bg:\s*color-mix\(in oklab,\s*#ffffff 40%,\s*#f7f1e6\)/,
    )
  })

  it('paints Clay warning as yellow-amber (hue 75), not peach/danger', () => {
    expect(clayLightTokenBodies).toMatch(/--color-warning:\s*oklch\(0\.78 0\.09 75\)/)
    expect(clayLightTokenBodies).toMatch(/--color-warning-text:\s*oklch\(0\.48 0\.1 75\)/)
    expect(clayDarkTokenBodies).toMatch(/--color-warning:\s*oklch\(0\.8 0\.09 75\)/)
    expect(clayDarkTokenBodies).toMatch(/--color-warning-text:\s*oklch\(0\.72 0\.1 75\)/)
  })

  it('locks --color-app, --color-fg, and --color-border-default to the Clay dark ladder', () => {
    expect(clayDarkTokenBodies).toMatch(/--color-app:\s*#171513/)
    expect(clayDarkTokenBodies).toMatch(/--color-fg:\s*#f0ebe3/)
    expect(clayDarkTokenBodies).toMatch(/--color-border-default:\s*#f0ebe31a/)
    expect(clayDarkTokenBodies).toMatch(/--color-fg-muted:\s*#b3aa9e/)
  })

  it('does not use a bare .ds-clay or .dark.ds-clay selector', () => {
    const illegal: string[] = []
    for (const match of cssCode.matchAll(/\.ds-clay(?![a-z0-9-])/g)) {
      const prefix = cssCode.slice(0, match.index)
      if (!prefix.endsWith(':root') && !prefix.endsWith(':root.dark')) {
        const from = Math.max(0, match.index - 24)
        illegal.push(cssCode.slice(from, match.index + '.ds-clay'.length).trim())
      }
    }
    expect(illegal).toEqual([])
  })

  it('does not override --font-title so titles stay Fraunces Variable', () => {
    expect(clayTokenBodies).not.toContain('--font-title:')
  })

  it('uses Baloo 2 UI, Fraunces display and a 16px root so rem steps land on 12 / 14 / 16', () => {
    expect(clayLightTokenBodies).toMatch(/--font-sans:\s*'Baloo 2 Variable'/)
    expect(clayLightTokenBodies).toMatch(/--font-display:\s*'Fraunces Variable'/)
    expect(clayLightTokenBodies).toMatch(/font-size:\s*16px/)
    expect(clayLightTokenBodies).toMatch(
      /--text-2xs:\s*calc\(0\.75rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\)/,
    )
    expect(clayLightTokenBodies).toMatch(
      /--text-xs:\s*calc\(0\.875rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\)/,
    )
    expect(clayLightTokenBodies).toMatch(
      /--text-sm:\s*calc\(0\.875rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\)/,
    )
    expect(clayLightTokenBodies).toMatch(
      /--text-base:\s*calc\(1rem\s*\*\s*var\(--ui-font-scale\)\s*\*\s*var\(--ds-type-scale\)\)/,
    )
  })

  it('defines a convex CTA extrusion on light and dark Clay', () => {
    expect(clayLightTokenBodies).toMatch(/--shadow-cta:/)
    expect(clayLightTokenBodies).toMatch(/--shadow-cta-pressed:/)
    expect(clayDarkTokenBodies).toMatch(/--shadow-cta:/)
    expect(clayDarkTokenBodies).toMatch(/--shadow-cta-pressed:/)
    // Kit §5: opaque extrusion edge of --rise, collapsed to 0 on press.
    expect(clayLightTokenBodies).toMatch(/--rise:\s*4px/)
    expect(clayLightTokenBodies).toMatch(/0 var\(--rise\) 0 0 var\(--color-accent-deep\)/)
    expect(clayDarkTokenBodies).toMatch(/0 var\(--rise\) 0 0 var\(--color-accent-deep\)/)
    expect(clayLightTokenBodies).toMatch(
      /--shadow-cta-pressed:\s*0 0 0 0 var\(--color-accent-deep\)/,
    )
  })

  it('Clay ghost is chrome-less at rest and a raised chip on hover', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='ghost'\]\s*\{[^}]*box-shadow:\s*none/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='ghost'\]\s*\{[^}]*background-color:\s*transparent/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='ghost'\]:hover:not\(:disabled\)\s*\{[^}]*box-shadow:\s*var\(--shadow-control\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='ghost'\]:hover:not\(:disabled\)\s*\{[^}]*transform:\s*translateY\(-1px\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='ghost'\]:active:not\(:disabled\)\s*\{[^}]*translateY\(var\(--rise\)\)/,
    )
  })

  it('Clay secondary uses the same 4px under-bar as primary', () => {
    expect(clayLightTokenBodies).toMatch(/0 var\(--rise\) 0 0 var\(--slab-deep\)/)
    expect(clayDarkTokenBodies).toMatch(/0 var\(--rise\) 0 0 var\(--slab-deep\)/)
    expect(clayLightTokenBodies).toMatch(/--color-button-slab:\s*#f7f1e6/)
    expect(clayDarkTokenBodies).toMatch(/--color-button-slab:\s*#4d463e/)
    // The lip must sit above the dark canvas, not below it: near-black read as
    // a cast shadow and made secondary look shorter than primary.
    expect(clayDarkTokenBodies).toMatch(/--slab-deep:\s*#37312a/)
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='secondary'\],\s*:root\.ds-clay\s+button\[data-variant='outline-secondary'\],\s*:root\.ds-clay\s+button\[data-variant='secondary-outline'\]\s*\{[^}]*background-color:\s*var\(--color-button-slab\)[^}]*box-shadow:\s*var\(--shadow-control\)/,
    )
    expect(cssCode).not.toMatch(
      /:root\.ds-clay\s+button\[data-variant='secondary'\][^}]*--rise:\s*3px/,
    )
  })

  it('Clay destructive is a danger clay slab (kit §6), not an outline', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='destructive'\]\s*\{[^}]*background:\s*var\(--danger-face\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='destructive'\]:hover:not\(:disabled\)\s*\{[^}]*transform:\s*translateY\(-1px\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+button\[data-variant='destructive'\]:active:not\(:disabled\)\s*\{[^}]*0 0 0 0 var\(--danger-lip\)/,
    )
  })

  it('paints a convex Clay second-panel tray (shadow + top-lit wash)', () => {
    expect(clayLightTokenBodies).toMatch(/--shadow-panel:\s*var\(--elev-2\)/)
    expect(clayDarkTokenBodies).toMatch(/--shadow-panel:\s*var\(--elev-2\)/)
    expect(clayLightTokenBodies).toMatch(/--grad-surface:\s*linear-gradient\(180deg/)
    expect(clayDarkTokenBodies).toMatch(/--grad-surface:\s*linear-gradient\(180deg/)
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-second-panel\s*>\s*div\s*\{[^}]*background-image:\s*var\(--grad-surface\)/,
    )
    expect(cssCode).not.toMatch(/:root\.ds-clay\s+\.xj-second-panel\s+\.badge-border\s*>\s*\*/)
  })

  it('paints the same top-lit wash on Clay third / single panels', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-main-panel\s*\{[^}]*background-image:\s*var\(--grad-surface\)/,
    )
  })

  it('pins Clay card elevation to --shadow-card without a broad rounded-2xl wash', () => {
    // Broad `.rounded-2xl.border` wash removed in b639a023 (too many hosts).
    // docs/later/2026-09-03-clay-rounded-2xl-card-wash-test.md
    expect(clayLightTokenBodies).toMatch(/--shadow-card:\s*var\(--elev-2\)/)
    expect(clayDarkTokenBodies).toMatch(/--shadow-card:\s*var\(--elev-2\)/)
    expect(cssCode).not.toMatch(
      /:root\.ds-clay\s+\.rounded-2xl\.border\s*\{[^}]*background-image:\s*var\(--grad-surface\)/,
    )
  })

  it('paints a convex Clay toggle-on extrusion', () => {
    expect(clayLightTokenBodies).toMatch(/--shadow-control:/)
    expect(clayDarkTokenBodies).toMatch(/--shadow-control:/)
    expect(clayLightTokenBodies).toMatch(/--shadow-toggle-on:/)
    expect(clayDarkTokenBodies).toMatch(/--shadow-toggle-on:/)
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\[role=['"]switch['"]\]\.gradient-primary\s*\{[^}]*box-shadow:\s*var\(--shadow-toggle-on\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\[role=['"]switch['"]\]\.gradient-primary\s+span\s*\{[^}]*background-color:\s*var\(--color-fg-inverse\)/,
    )
    // Off track is a neutral well (kit §7), not a raised slab.
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\[role=['"]switch['"]\]:not\(\.gradient-primary\)\s*\{[^}]*box-shadow:\s*var\(--shadow-track\)/,
    )
  })

  it('paints Clay selected nav with a 3D chip on light and wash-only on dark', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-nav-active\s*\{[^}]*background-image:\s*var\(--grad-surface\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-nav-active\s*\{[^}]*box-shadow:\s*var\(--shadow-chip\)/,
    )
    expect(cssCode).toMatch(/:root\.dark\.ds-clay\s+\.xj-nav-active/)
    expect(cssCode).toMatch(
      /:root\.dark\.ds-clay\s+\.xj-nav-active(?:,\s*:root\.dark\.ds-clay\s+\.xj-second-panel\s+\.xj-nav-active)?\s*\{[^}]*box-shadow:\s*none/,
    )
  })

  it('retunes Clay second-panel selected/hover so chips contrast on the tray', () => {
    expect(clayLightTokenBodies).toMatch(/--nav-rail-active-bg:\s*#e7ddd0/)
    expect(clayLightTokenBodies).toMatch(
      /--nav-rail-hover-bg:\s*color-mix\(in oklab,\s*#e7ddd0 50%,\s*#f7f1e6\)/,
    )
    expect(clayDarkTokenBodies).toMatch(/--nav-rail-active-bg:\s*#3a352f/)
    expect(clayDarkTokenBodies).toMatch(/--nav-rail-hover-bg:\s*#2c2926/)
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-second-panel\s*\{[^}]*--nav-active-bg:\s*var\(--nav-rail-active-bg\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-second-panel\s+\[role=['"]tab['"]\]:not\(\.xj-nav-active\):hover\s*\{[^}]*background-color:\s*var\(--nav-rail-hover-bg\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-second-panel\s+\.xj-chat-row:hover\s*\{[^}]*background-color:\s*var\(--nav-rail-hover-bg\)/,
    )
    expect(cssCode).toMatch(
      /:root\.dark\.ds-clay\s+\.xj-second-panel\s+\.xj-chat-row:hover\s*\{[^}]*background-color:\s*var\(--color-surface-hi\)/,
    )
    // Entry cards are `[role='button']` rows in the same tray; the Clay chat
    // hover must not repaint them under their cover wash.
    expect(cssCode).not.toMatch(/:root\.ds-clay\s+\.xj-second-panel\s+\[role=['"]button['"]\]/)
    expect(clayLightTokenBodies).toMatch(
      /--nav-hover-bg:\s*color-mix\(in oklab,\s*#f7f1e6 85%,\s*#ebe3d6\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-sidebar-nav\s+button:not\(\.xj-nav-active\):hover\s*\{[^}]*background-color:\s*var\(--nav-hover-bg\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+\.xj-second-panel\s+\.xj-nav-active\s*\{[^}]*box-shadow:\s*none/,
    )
  })

  it('mirrors the Clay press-physics reduced-motion rule on the JS .reduce-motion class', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay\.reduce-motion\s+button\[data-variant\]:hover:not\(:disabled\),[^{]*\{[^}]*transform:\s*none/,
    )
  })

  it('paints Clay text inputs as inset wells (kit §9), not slabs', () => {
    expect(clayLightTokenBodies).toMatch(/--shadow-well:\s*inset 0 2px 5px var\(--neu-press\)/)
    expect(cssCode).toMatch(
      /:root\.ds-clay\s+input:not\(\[type=['"]checkbox['"]\]\)[\s\S]*textarea:not\(\.xj-input-bare\):not\(\.xj-entry-title\)\s*\{[^}]*box-shadow:\s*var\(--shadow-well\)/,
    )
  })

  it('does not paint 3D wash on the entry editor title', () => {
    expect(cssCode).toMatch(/:root\.ds-clay\s+\.xj-entry-title\s*\{[^}]*background-image:\s*none/)
  })

  it('every --color-* referenced by a Clay value is defined in globals.css', () => {
    const referenced = new Set<string>()
    for (const match of clayRuleBodies.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      if (match[1] !== undefined) referenced.add(match[1])
    }
    expect(referenced.size).toBeGreaterThan(0)

    const defined = new Set(
      customPropertyNames(cssCode).filter((name) => name.startsWith('--color-')),
    )
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })
})

/**
 * Scripted WCAG AA 4.5:1 check across the eight shipping surfaces.
 *
 * No text-role exemptions: `--color-fg-faint` used to be excused here as
 * "decorative", but every consumer was readable type and it cleared 4.5:1 on
 * none of the eight surfaces — the token is deleted, not exempted.
 * Primary CTA fill is `--color-accent-fill` on every surface.
 *
 * `--color-accent-fill` is a chroma-preserving oklch in both modes (the
 * lightest L that still clears 4.5:1 with `--color-fg-inverse`), except
 * Clay: kit hex slabs carry white labels by design direction (see
 * docs/design/DESIGN_clay.md); `--color-accent-text` is the AA net there.
 * Buttons paint `--grad-accent-fill` (two-stop sweep of that fill). Clean
 * blocks omit `--color-accent` / `--color-accent-fill` (inline from
 * applyAccent); cascade still sees `@theme` / `.dark` Sky tokens (default
 * preset). Lumen omits `--color-accent` the same way so first paint is Sky
 * until applyAccent writes the user preset. Raw Sky *chrome* accent vs
 * white is below AA and is not this pair.
 */

describe('WCAG AA 4.5:1 — eight shipping surfaces', () => {
  it('oklch(0 0 0) on oklch(1 0 0) is 21:1 (Y = L³)', () => {
    const ratio = wcagContrastRatio(parseCssColor('oklch(0 0 0)'), parseCssColor('oklch(1 0 0)'))
    expect(ratio).toBeCloseTo(21, 5)
  })

  it('hex luminance matches getContrastRatio, including 3-digit #eee', () => {
    const a = parseHexColor('#0d0d0d')
    const b = parseHexColor('#eee')
    expect(wcagContrastRatio(a, b)).toBeCloseTo(getContrastRatio('#0d0d0d', '#eeeeee'), 5)
  })

  it.each([
    { id: 'signature-light' as const, app: '#f4f3f1' },
    { id: 'signature-dark' as const, app: '#0d0d0d' },
    { id: 'signature-soft' as const, app: '#141414' },
    { id: 'clean-light' as const, app: 'oklch(0.985 0 0)' },
    { id: 'clean-dark' as const, app: 'oklch(0.09 0 0)' },
    { id: 'lumen-dark' as const, app: 'oklch(13% 0.014 265)' },
    { id: 'clay-light' as const, app: '#ebe3d6' },
    { id: 'clay-dark' as const, app: '#171513' },
  ])('$id resolves --color-app to the shipping ladder', ({ id, app }) => {
    expect(tokensBySurface[id].get('--color-app')).toBe(app)
  })

  it('resolves Clean --color-accent from @theme/.dark Sky (not skipped)', () => {
    expect(tokensBySurface['clean-light'].get('--color-accent')).toBe('oklch(55% 0.18 230)')
    expect(tokensBySurface['clean-dark'].get('--color-accent')).toBe('oklch(72% 0.15 230)')
    expect(tokensBySurface['clean-light'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
  })

  it('resolves Lumen --color-accent from Signature .dark Sky (not pinned brass)', () => {
    expect(tokensBySurface['lumen-dark'].get('--color-accent')).toBe('oklch(72% 0.15 230)')
    expect(tokensBySurface['lumen-dark'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
  })

  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) =>
      FG_ROLES.flatMap((fg) => SURFACE_ROLES.map((bg) => ({ id, label, fg, bg }))),
    ),
  )('$label: $fg on $bg ≥ 4.5:1', ({ id, fg, bg }) => {
    expect(contrastOf(tokensBySurface[id], fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  it.each(
    (['clay-light', 'clay-dark'] as const).flatMap((id) =>
      FG_ROLES.flatMap((fg) =>
        CLAY_EXTRA_SURFACE_ROLES.map((bg) => ({
          id,
          label:
            id === 'clay-light' ? 'Clay light (:root.ds-clay)' : 'Clay dark (:root.dark.ds-clay)',
          fg,
          bg,
        })),
      ),
    ),
  )('$label: $fg on $bg ≥ 4.5:1', ({ id, fg, bg }) => {
    expect(contrastOf(tokensBySurface[id], fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) =>
      STATUS_TEXT_ROLES.flatMap((fg) => STATUS_SURFACES.map((bg) => ({ id, label, fg, bg }))),
    ),
  )('$label: $fg on $bg ≥ 4.5:1', ({ id, fg, bg }) => {
    expect(contrastOf(tokensBySurface[id], fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  // Destructive Button + error copy sit on elevated / panel-1 / panel-2.
  // `--color-danger` fails AA on Soft elevated; `--color-danger-text` must
  // clear 4.5:1 on every raised surface the variant actually paints on.
  const DANGER_TEXT_SURFACES = ['--color-elevated', '--color-panel-1', '--color-panel-2'] as const
  it.each(
    SHIPPING_SURFACES.flatMap(({ id, label }) =>
      DANGER_TEXT_SURFACES.map((bg) => ({ id, label, bg })),
    ),
  )('$label: --color-danger-text on $bg ≥ 4.5:1', ({ id, bg }) => {
    expect(contrastOf(tokensBySurface[id], '--color-danger-text', bg)).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  it('Clay dark --color-danger-text is lighter than --color-danger (not a no-op copy)', () => {
    const tokens = tokensBySurface['clay-dark']
    expect(tokens.get('--color-danger-text')).not.toBe(tokens.get('--color-danger'))
    const dangerY = relativeLuminance(tokenColor(tokens, '--color-danger'))
    const textY = relativeLuminance(tokenColor(tokens, '--color-danger-text'))
    expect(textY).toBeGreaterThan(dangerY)
  })

  // Clay writes --color-accent-fill inline from its own sheet (themeColors.test
  // covers it); the stylesheet fallback seen here is Signature's Sky, which
  // Clay never paints — so both Clay surfaces are excluded.
  it.each(
    SHIPPING_SURFACES.filter(
      (surface) => surface.id !== 'clay-light' && surface.id !== 'clay-dark',
    ),
  )('$label: --color-fg-inverse on --color-accent-fill ≥ 4.5:1', ({ id }) => {
    expect(
      contrastOf(tokensBySurface[id], '--color-fg-inverse', '--color-accent-fill'),
    ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  // Clean paints destructive buttons as a solid --color-danger-fill with
  // --color-fg-inverse text (shadcn `bg-destructive text-white`). Clay builds
  // its slab from --danger-face / --cta-face instead; both are asserted below.
  it.each(['clean-light', 'clean-dark'] as const)(
    '%s: --color-fg-inverse on --color-danger-fill ≥ 4.5:1',
    (id) => {
      expect(
        contrastOf(tokensBySurface[id], '--color-fg-inverse', '--color-danger-fill'),
      ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
    },
  )

  // The Clay button slabs. These are what actually paint: the destructive
  // rule stamps --cta-ink on --danger-face, primary on --cta-face. Both faces
  // pin OKLCH L to 0.52 precisely so the white label clears AA, so these are
  // the assertions that make that claim real rather than a comment.
  it.each(['clay-light', 'clay-dark'] as const)('%s: --cta-ink on --danger-face >= 4.5:1', (id) => {
    expect(contrastOf(tokensBySurface[id], '--cta-ink', '--danger-face')).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  it.each(['clay-light', 'clay-dark'] as const)('%s: --cta-ink on --cta-face >= 4.5:1', (id) => {
    expect(contrastOf(tokensBySurface[id], '--cta-ink', '--cta-face')).toBeGreaterThanOrEqual(
      WCAG_AA_MIN,
    )
  })

  // Every OTHER Clay accent slab that carries a label must use the same
  // face+ink pair as the CTA button. The selected calendar day and the
  // segmented-control active radio used to stamp --color-fg-inverse on the
  // raw --grad-accent-fill, which measured 2.47–4.29:1 in light across the
  // six presets — the button fix did not reach them.
  it('paints the Clay selected calendar day with the CTA face + ink', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-cal-day\[aria-pressed='true'\]\s*\{[^}]*background:\s*var\(--cta-face\)[^}]*color:\s*var\(--cta-ink\)/,
    )
  })

  it('paints the Clay segmented thumb with the CTA face + ink', () => {
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-seg-thumb\s*\{[^}]*background:\s*var\(--cta-face\)/,
    )
    expect(cssCode).toMatch(
      /:root\.ds-clay \.xj-seg \[role='radio'\]\[aria-checked='true'\]\s*\{[^}]*color:\s*var\(--cta-ink\)/,
    )
  })

  it('leaves no Clay rule stamping --color-fg-inverse on an accent slab', () => {
    const clayFgInverse = [
      ...cssCode.matchAll(
        /:root(?:\.dark)?\.ds-clay [^{]*\{[^}]*[^-]color:\s*var\(--color-fg-inverse\)/g,
      ),
    ]
    expect(clayFgInverse.map((m) => m[0].split('{')[0].trim())).toEqual([])
  })

  // WCAG 2.4.7: text fields suppress the global offset ring (it reads as a
  // second box around the field), so they must paint their own indicator.
  // Clay already did via its own inset ring; Signature and Clean painted
  // nothing at all and left the blinking caret as the only focus signal.
  it('text fields paint a focus ring instead of only suppressing the outline', () => {
    const rule = cssCode.match(
      /input:not\([^)]*\):focus-visible,\s*textarea:focus-visible\s*\{([^}]*)\}/,
    )
    expect(rule, 'shared text-field focus rule not found').not.toBeNull()
    expect(rule![1]).toMatch(/outline:\s*none/)
    expect(rule![1]).toMatch(/box-shadow:[^;]*var\(--color-focus-ring\)/)
  })

  it('Clean pins --radius-2xl to the shadcn Card radius (0.75rem)', () => {
    expect(cleanLightTokenBodies).toMatch(/--radius-2xl:\s*0\.75rem/)
  })

  it('accent-fill is chroma-preserving oklch in light and dark', () => {
    expect(tokensBySurface['signature-light'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
    expect(tokensBySurface['clean-light'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
    expect(tokensBySurface['signature-dark'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
    expect(tokensBySurface['clean-dark'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
    expect(tokensBySurface['lumen-dark'].get('--color-accent-fill')).toBe('oklch(53% 0.2 230)')
  })

  // Warning / danger boxes are solid paper (no alpha). Ink must clear AA
  // on that paper — not on the page surface — across every shipping skin.
  it.each(SHIPPING_SURFACES)(
    '$label: --color-warning-fg on --color-warning-bg ≥ 4.5:1',
    ({ id }) => {
      expect(
        contrastOf(tokensBySurface[id], '--color-warning-fg', '--color-warning-bg'),
      ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
    },
  )

  it.each(SHIPPING_SURFACES)('$label: --color-danger-fg on --color-danger-bg ≥ 4.5:1', ({ id }) => {
    expect(
      contrastOf(tokensBySurface[id], '--color-danger-fg', '--color-danger-bg'),
    ).toBeGreaterThanOrEqual(WCAG_AA_MIN)
  })

  it('warning / danger box tokens are the shared bright paper recipe', () => {
    const lightIds = ['signature-light', 'clean-light', 'clay-light'] as const
    const darkIds = [
      'signature-dark',
      'signature-soft',
      'lumen-dark',
      'clean-dark',
      'clay-dark',
    ] as const
    for (const id of lightIds) {
      expect(tokensBySurface[id].get('--color-warning-bg')).toBe('oklch(0.95 0.1 82)')
      expect(tokensBySurface[id].get('--color-warning-border')).toBe('oklch(0.88 0.11 78)')
      expect(tokensBySurface[id].get('--color-warning-fg')).toBe('oklch(0.45 0.14 55)')
      expect(tokensBySurface[id].get('--color-danger-bg')).toBe('oklch(0.95 0.04 22)')
      expect(tokensBySurface[id].get('--color-danger-border')).toBe('oklch(0.88 0.06 22)')
      expect(tokensBySurface[id].get('--color-danger-fg')).toBe('oklch(0.45 0.18 25)')
    }
    for (const id of darkIds) {
      expect(tokensBySurface[id].get('--color-warning-bg')).toBe('oklch(0.93 0.11 82)')
      expect(tokensBySurface[id].get('--color-warning-border')).toBe('oklch(0.86 0.12 78)')
      expect(tokensBySurface[id].get('--color-warning-fg')).toBe('oklch(0.4 0.14 52)')
      expect(tokensBySurface[id].get('--color-danger-bg')).toBe('oklch(0.91 0.05 20)')
      expect(tokensBySurface[id].get('--color-danger-border')).toBe('oklch(0.84 0.07 20)')
      expect(tokensBySurface[id].get('--color-danger-fg')).toBe('oklch(0.4 0.17 25)')
    }
  })
})

describe('Entry-card fill interpolation', () => {
  it('registers --entry-card-fill as an interpolating <color> @property', () => {
    expect(cssCode).toMatch(/@property\s+--entry-card-fill\s*\{[^}]*syntax:\s*['"]<color>['"]/)
  })
})

describe('Entry-card idle cover wash matches the list surface', () => {
  // Pin the wash to the color the transparent row actually sits on.
  // Signature (all modes): SecondPanel `bg-selected-tab`. Clean light:
  // column `bg-panel-3`. Clean dark: `bg-panel-2`.

  it.each([
    'signature-light',
    'signature-dark',
    'signature-soft',
    'lumen-dark',
    'clay-light',
    'clay-dark',
  ] as const)('%s idle wash equals painted row --color-selected-tab', (id) => {
    expect(tokenColor(tokensBySurface[id], '--entry-card-idle-bg')).toEqual(
      tokenColor(tokensBySurface[id], '--color-selected-tab'),
    )
  })

  it('clean-light idle wash equals painted column --color-panel-3', () => {
    expect(tokenColor(tokensBySurface['clean-light'], '--entry-card-idle-bg')).toEqual(
      tokenColor(tokensBySurface['clean-light'], '--color-panel-3'),
    )
  })

  // Clean light is excluded: every panel is white there, so idle == panel-2 ==
  // panel-3 by design and the seam cannot occur.
  it.each(['signature-light', 'signature-dark', 'clay-dark'] as const)(
    '%s idle wash is not --color-panel-2 (the original seam)',
    (id) => {
      expect(tokenColor(tokensBySurface[id], '--entry-card-idle-bg')).not.toEqual(
        tokenColor(tokensBySurface[id], '--color-panel-2'),
      )
    },
  )

  it('clean-dark idle wash equals --color-panel-2', () => {
    expect(tokenColor(tokensBySurface['clean-dark'], '--entry-card-idle-bg')).toEqual(
      tokenColor(tokensBySurface['clean-dark'], '--color-panel-2'),
    )
  })
})

describe('Entry-card hover cover wash matches the hover fill', () => {
  // Signature hover is a mix of `--color-selected-tab` toward white, so
  // editing the tab token moves idle and hover together. Clean hover is
  // still the elevated row fill.
  it.each(['signature-light', 'signature-dark', 'signature-soft'] as const)(
    '%s hover wash is mixed from --color-selected-tab',
    (id) => {
      const raw = tokensBySurface[id].get('--entry-card-hover-bg') ?? ''
      expect(raw).toMatch(/var\(--color-selected-tab\)/)
      expect(raw).toMatch(/color-mix\(in oklab/i)
      expect(tokenColor(tokensBySurface[id], '--entry-card-hover-bg')).not.toEqual(
        tokenColor(tokensBySurface[id], '--color-selected-tab'),
      )
      const idleY = relativeLuminance(tokenColor(tokensBySurface[id], '--entry-card-idle-bg'))
      const hoverY = relativeLuminance(tokenColor(tokensBySurface[id], '--entry-card-hover-bg'))
      expect(hoverY).toBeGreaterThan(idleY)
    },
  )

  it.each(['signature-dark', 'signature-soft'] as const)(
    '%s hover wash is not the old --color-surface-hi pin',
    (id) => {
      expect(tokenColor(tokensBySurface[id], '--entry-card-hover-bg')).not.toEqual(
        tokenColor(tokensBySurface[id], '--color-surface-hi'),
      )
    },
  )

  it('clean-dark hover wash equals --color-surface-hi', () => {
    expect(tokenColor(tokensBySurface['clean-dark'], '--entry-card-hover-bg')).toEqual(
      tokenColor(tokensBySurface['clean-dark'], '--color-surface-hi'),
    )
    expect(tokenColor(tokensBySurface['clean-dark'], '--entry-card-hover-bg')).not.toEqual(
      tokenColor(tokensBySurface['clean-dark'], '--color-elevated'),
    )
  })

  it('clean-light hover wash tints below the white idle card', () => {
    expect(tokenColor(tokensBySurface['clean-light'], '--entry-card-hover-bg')).not.toEqual(
      tokenColor(tokensBySurface['clean-light'], '--entry-card-idle-bg'),
    )
  })
})
