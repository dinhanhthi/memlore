import { LIGHT_MODE_ENABLED } from './themeConfig'

/**
 * User-selectable design-system union and the DOM/class contract that
 * paints it. Mirrors the role `themeConfig.ts` plays for the old
 * light-mode flag: a leaf module with no store or React imports so
 * boot scripts, theme appliers, and the store can all share one
 * coercion + class-name source of truth.
 */
export type DesignSystem = 'signature' | 'clean' | 'clay'

export const DESIGN_SYSTEMS: readonly DesignSystem[] = ['signature', 'clean', 'clay']

export const DEFAULT_DESIGN_SYSTEM: DesignSystem = 'clay'

export const DESIGN_SYSTEM_CLASS: Record<DesignSystem, string> = {
  signature: 'ds-signature',
  clean: 'ds-clean',
  clay: 'ds-clay',
}

function isDesignSystem(v: unknown): v is DesignSystem {
  return typeof v === 'string' && (DESIGN_SYSTEMS as readonly string[]).includes(v)
}

/** Anything not in `DESIGN_SYSTEMS` falls back to the default (clay). */
export function coerceDesignSystem(v: unknown): DesignSystem {
  return isDesignSystem(v) ? v : DEFAULT_DESIGN_SYSTEM
}

/**
 * Dark canvas style — orthogonal to the design-system union. `deep` is the
 * Signature charcoal default (`.dark`); `soft` lifts that ladder via
 * `.dark.surface-soft`; `lumen` is a Signature-only night surface
 * (`.dark.surface-lumen`). Only affects dark mode.
 */
export type SurfaceStyle = 'deep' | 'soft' | 'lumen'

export const SURFACE_STYLES: readonly SurfaceStyle[] = ['deep', 'soft', 'lumen']

export const DEFAULT_SURFACE_STYLE: SurfaceStyle = 'deep'

function isSurfaceStyle(v: unknown): v is SurfaceStyle {
  return typeof v === 'string' && (SURFACE_STYLES as readonly string[]).includes(v)
}

/** Anything not in `SURFACE_STYLES` falls back to the default (deep). */
export function coerceSurfaceStyle(v: unknown): SurfaceStyle {
  return isSurfaceStyle(v) ? v : DEFAULT_SURFACE_STYLE
}

/**
 * Clean-only corner-radius level — orthogonal to the design-system
 * union. `low` is today's Clean rendering (stamps no class);
 * `medium` stamps `.rad-medium`; `high` stamps `.rad-high`.
 */
export type CornerRadius = 'low' | 'medium' | 'high'

export const CORNER_RADII: readonly CornerRadius[] = ['low', 'medium', 'high']

export const DEFAULT_CORNER_RADIUS: CornerRadius = 'low'

function isCornerRadius(v: unknown): v is CornerRadius {
  return typeof v === 'string' && (CORNER_RADII as readonly string[]).includes(v)
}

/** Anything not in `CORNER_RADII` falls back to the default (low). */
export function coerceCornerRadius(v: unknown): CornerRadius {
  return isCornerRadius(v) ? v : DEFAULT_CORNER_RADIUS
}

/**
 * Toggle `rad-medium` / `rad-high` so exactly one (or zero) class is
 * present. Low stamps nothing. Classes are stamped unconditionally;
 * the CSS that consumes them is scoped to `:root.ds-clean`, so a
 * stored level is inert under Signature/Clay.
 */
export function applyCornerRadius(r: CornerRadius): void {
  const root = document.documentElement.classList
  root.toggle('rad-medium', r === 'medium')
  root.toggle('rad-high', r === 'high')
}

/**
 * Clean and Clay always allow light mode (even with a stored lumen
 * surface — surface styles are Signature-only). Signature is gated by
 * `LIGHT_MODE_ENABLED`, except Signature + lumen which is always
 * dark-only.
 */
export function lightModeAllowed(
  ds: DesignSystem,
  surface: SurfaceStyle = DEFAULT_SURFACE_STYLE,
): boolean {
  if (ds === 'signature' && surface === 'lumen') return false
  return ds === 'clean' || ds === 'clay' || (ds === 'signature' && LIGHT_MODE_ENABLED)
}

/**
 * Reads the active design system from the root class list. `ds-clean`
 * and `ds-clay` are checked explicitly (`ds-clean` wins if both are
 * present); anything else (including leftover `ds-lumen`) is signature —
 * same DOM-read pattern as `applyAccent` checking `classList.contains('dark')`.
 */
export function readActiveDesignSystem(): DesignSystem {
  const classes = document.documentElement.classList
  if (classes.contains(DESIGN_SYSTEM_CLASS.clean)) return 'clean'
  if (classes.contains(DESIGN_SYSTEM_CLASS.clay)) return 'clay'
  return 'signature'
}

/** Toggle `ds-*` so exactly one current system class is present; always
 *  strip leftover `ds-lumen` from the former third-system era. */
export function applyDesignSystem(ds: DesignSystem): void {
  const root = document.documentElement.classList
  for (const system of DESIGN_SYSTEMS) {
    root.toggle(DESIGN_SYSTEM_CLASS[system], system === ds)
  }
  root.remove('ds-lumen')
}
