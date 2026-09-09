import { convertFileSrc } from '@tauri-apps/api/core'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { deleteSetting, getSetting, setSetting } from '../lib/tauri'
import {
  applyAccent,
  applyFont,
  applyFontContrast,
  applyFontSize,
  applySurfaceStyle,
  clampFontContrast,
  clampFontSize,
  coerceSurfaceStyle,
  DEFAULT_FONT_SIZE_BY_FAMILY,
  defaultFontSizeFor,
  FONT_CONTRAST_DEFAULT,
  loadCustomGoogleFont,
  unloadCustomGoogleFont,
  type AccentPreset,
  type FontFamily,
  type SurfaceStyle,
} from '../lib/themeColors'
import { ACCENT_PRESETS, DEFAULT_ACCENT_HEX, DEFAULT_ACCENT_PRESET } from '../lib/accentPresets'
import { useUiStore } from '../stores/uiStore'
import { useTheme } from './useTheme'

// Single source of truth for the FontFamily union — derived from the keyed
// record so dropping a font in themeColors.ts auto-prunes it from this
// allowlist with no parallel list to keep in sync.
const KNOWN_FONT_FAMILIES = new Set<string>(Object.keys(DEFAULT_FONT_SIZE_BY_FAMILY))
const KNOWN_ACCENT_PRESETS = new Set<string>([...ACCENT_PRESETS.map((p) => p.id), 'custom'])

const DEFAULT_FONT_FAMILY: FontFamily = 'nunito'
const DEFAULTS = {
  accentPreset: DEFAULT_ACCENT_PRESET,
  accentHex: DEFAULT_ACCENT_HEX,
  // SuperX deep charcoal is the product default; soft is an optional lift.
  surfaceStyle: 'deep' as SurfaceStyle,
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: defaultFontSizeFor(DEFAULT_FONT_FAMILY),
  fontContrast: FONT_CONTRAST_DEFAULT,
}

// Settings keys for the Custom Google Font slot. All three must be present
// to consider the slot configured; if any is missing on load we fall back
// to the default font.
const KEY_CUSTOM_FAMILY = 'theme_custom_google_font_family'
const KEY_CUSTOM_WEIGHT = 'theme_custom_google_font_weight'
const KEY_CUSTOM_LOCAL_PATH = 'theme_custom_google_font_local_path'

// Per-font overrides — keyed by FontFamily. Missing keys fall back to the
// family's per-font default (size) or FONT_CONTRAST_DEFAULT (contrast).
// Persisted as a single JSON blob per key so switching fonts can restore
// whatever the user last set for that face.
type FontOverrides = Partial<Record<FontFamily, number>>

interface AccentState {
  preset: AccentPreset
  hex: string
  surfaceStyle: SurfaceStyle
  font: FontFamily
  fontSize: number
  fontContrast: number
  sizeOverrides: FontOverrides
  contrastOverrides: FontOverrides
  // Custom Google Font slot — null when no custom font has been picked
  // (or after the cache has been cleared).
  customGoogleFontFamily: string | null
  customGoogleFontWeight: number
  customGoogleFontLocalPath: string | null
  loaded: boolean
}

// Module-level single source of truth shared by every hook caller. The
// useCallback setters below have an empty dep array and intentionally read
// this as live mutable module state — they always observe the latest
// override maps, font, etc. without resubscribing. If this is ever
// refactored to React state, the setters must be updated to read from the
// hook closure or via refs; the empty dep array silently becomes a stale
// closure bug otherwise.
let state: AccentState = {
  preset: DEFAULTS.accentPreset,
  hex: DEFAULTS.accentHex,
  surfaceStyle: DEFAULTS.surfaceStyle,
  font: DEFAULTS.fontFamily,
  fontSize: DEFAULTS.fontSize,
  fontContrast: DEFAULTS.fontContrast,
  sizeOverrides: {},
  contrastOverrides: {},
  customGoogleFontFamily: null,
  customGoogleFontWeight: 400,
  customGoogleFontLocalPath: null,
  loaded: false,
}
const listeners = new Set<() => void>()
let loadPromise: Promise<void> | null = null

function notify() {
  for (const l of listeners) l()
}

function setState(patch: Partial<AccentState>) {
  state = { ...state, ...patch }
  notify()
}

/** Non-reactive read of the current surface style — for command palette.
 *  Reads the uiStore persist mirror so pre-unlock callers see migrated lumen
 *  instead of the module default (`deep` until `ensureLoaded`). */
export function getSurfaceStyle(): SurfaceStyle {
  return useUiStore.getState().surfaceStyle
}

/** Imperative setter — for command palette and non-React callers.
 *  Dual-writes uiStore persist + sqlite so boot/lock-screen stay in sync. */
export function setSurfaceStyleImperative(next: SurfaceStyle): void {
  setState({ surfaceStyle: next })
  applySurfaceStyle(next)
  useUiStore.getState().setSurfaceStyle(next)
  void setSetting('theme_surface_style', next)
}

function parseOverrides(raw: string | null): FontOverrides {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: FontOverrides = {}
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      // Drop unknown families (e.g. fonts removed from FontFamily in a later
      // release) so stale keys cannot survive a load → save round-trip and
      // accumulate forever in the persisted JSON blob.
      if (!KNOWN_FONT_FAMILIES.has(key)) continue
      if (typeof val === 'number' && Number.isFinite(val)) {
        out[key as FontFamily] = val
      }
    }
    return out
  } catch {
    return {}
  }
}

function sizeForFamily(family: FontFamily, overrides: FontOverrides): number {
  const raw = overrides[family]
  if (raw === undefined) return defaultFontSizeFor(family)
  return clampFontSize(raw)
}

function contrastForFamily(family: FontFamily, overrides: FontOverrides): number {
  const raw = overrides[family]
  if (raw === undefined) return FONT_CONTRAST_DEFAULT
  return clampFontContrast(raw)
}

/**
 * Force a re-read of all theme settings from the backend. Used after the
 * SQLCipher unlock swap (`commands::crypto::initialize_encryption`) — at that
 * point the backend connection has flipped from the empty `:memory:`
 * placeholder to the real DB, but `ensureLoaded()`'s cached `loadPromise`
 * would otherwise pin the frontend to the placeholder-derived defaults.
 *
 * Intentionally does NOT flip `loaded` back to false: the previously-loaded
 * snapshot is still a valid view of the world until the new read completes.
 * Resetting it would cause every consumer with an `if (!loaded) return`
 * guard (e.g. AppearanceSettings' +/- buttons) to refuse user input during
 * the reload window — silently dropping mid-interaction clicks on a manual
 * lock → unlock cycle.
 */
export function reloadThemeSettings(): Promise<void> {
  loadPromise = null
  return ensureLoaded()
}

export function getCurrentAccent(): { preset: AccentPreset; hex: string } {
  return { preset: state.preset, hex: state.hex }
}

function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const [
      preset,
      hex,
      surfaceStyleRaw,
      font,
      sizeOverridesRaw,
      contrastOverridesRaw,
      customFamily,
      customWeightRaw,
      customLocalPath,
    ] = await Promise.all([
      getSetting('theme_accent_preset'),
      getSetting('theme_accent_hex'),
      getSetting('theme_surface_style'),
      getSetting('theme_font_family'),
      getSetting('theme_font_size_overrides'),
      getSetting('theme_font_contrast_overrides'),
      getSetting(KEY_CUSTOM_FAMILY),
      getSetting(KEY_CUSTOM_WEIGHT),
      getSetting(KEY_CUSTOM_LOCAL_PATH),
    ])
    // lumen/soft round-trip; unset/garbage → 'deep'. A migrated uiStore
    // 'lumen' must not be clobbered by leftover sqlite deep/soft from the
    // Lumen-as-DS era — write sqlite instead. Otherwise sqlite wins and
    // backfills the persist mirror (so Soft users stop flashing Deep).
    let surfaceStyle = coerceSurfaceStyle(surfaceStyleRaw)
    const uiSurface = useUiStore.getState().surfaceStyle
    if (uiSurface === 'lumen' && surfaceStyle !== 'lumen') {
      surfaceStyle = 'lumen'
      await setSetting('theme_surface_style', 'lumen')
    } else if (uiSurface !== surfaceStyle) {
      useUiStore.getState().setSurfaceStyle(surfaceStyle)
    }
    const sizeOverrides = parseOverrides(sizeOverridesRaw)
    const contrastOverrides = parseOverrides(contrastOverridesRaw)
    let family = (font as FontFamily) || DEFAULTS.fontFamily
    // Normalize a persisted family that no longer exists (e.g. an old
    // 'playpen-sans' after that font was removed) so the Settings font
    // picker re-selects a valid pill instead of showing none. applyFont's
    // fallback still renders correctly either way; this keeps the UI honest.
    if (!KNOWN_FONT_FAMILIES.has(family)) family = DEFAULTS.fontFamily

    // Parse the persisted custom-font slot. All three keys must be present
    // for the slot to be considered valid — otherwise we treat it as empty
    // and (if `font === 'custom'`) fall back to the default family.
    const parsedCustomWeight = customWeightRaw ? Number.parseInt(customWeightRaw, 10) : NaN
    const customSlotValid =
      !!customFamily &&
      !!customLocalPath &&
      Number.isFinite(parsedCustomWeight) &&
      parsedCustomWeight > 0
    const customWeight = customSlotValid ? parsedCustomWeight : 400

    if (family === 'custom' && !customSlotValid) {
      family = DEFAULTS.fontFamily
    }

    // Rewrite stale theme_font_family values (removed fonts, invalid custom
    // slot) so the DB stays aligned with what the UI shows.
    if (font && family !== font) {
      await setSetting('theme_font_family', family)
    }

    const nextPreset: AccentPreset =
      preset && KNOWN_ACCENT_PRESETS.has(preset) ? (preset as AccentPreset) : DEFAULTS.accentPreset
    if (preset && nextPreset !== preset) {
      await setSetting('theme_accent_preset', nextPreset)
    }

    setState({
      preset: nextPreset,
      hex: hex || DEFAULTS.accentHex,
      surfaceStyle,
      font: family,
      fontSize: sizeForFamily(family, sizeOverrides),
      fontContrast: contrastForFamily(family, contrastOverrides),
      sizeOverrides,
      contrastOverrides,
      customGoogleFontFamily: customSlotValid ? customFamily : null,
      customGoogleFontWeight: customWeight,
      customGoogleFontLocalPath: customSlotValid ? customLocalPath : null,
      loaded: true,
    })

    applyAccent(state.preset, state.hex)
    applySurfaceStyle(state.surfaceStyle)
    // If the custom slot is valid we always inject the @font-face — even
    // when the active font is not 'custom' — so switching back to it
    // doesn't need a re-download.
    if (customSlotValid && customFamily && customLocalPath) {
      loadCustomGoogleFont(customFamily, customWeight, convertFileSrc(customLocalPath))
    }
    if (family === 'custom' && customSlotValid && customFamily) {
      applyFont('custom', customFamily, customWeight)
    } else {
      applyFont(family)
    }
    applyFontSize(state.fontSize)
    applyFontContrast(state.fontContrast)
  })()
  return loadPromise
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

function getSnapshot(): AccentState {
  return state
}

function useAccentState(): AccentState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useThemeCustomization() {
  const { resolvedTheme } = useTheme()
  const designSystem = useUiStore((s) => s.designSystem)
  const uiSurfaceStyle = useUiStore((s) => s.surfaceStyle)
  const { preset, hex, surfaceStyle, font, fontSize, fontContrast, loaded } = useAccentState()

  // Initial hydration is driven by `App.tsx` via `reloadThemeSettings()`
  // once the SQLCipher unlock swap has completed — calling `ensureLoaded()`
  // here would race the real-DB read against the `:memory:` placeholder and
  // freeze the frontend on placeholder-derived defaults. App.tsx is the
  // single source of truth for *when* the read happens.

  // Re-apply accent when theme changes so oklch lightness values update for
  // the new dark/light background. Reads from the shared module state, so
  // any concurrent hook instance (e.g. useThemeInit in App.tsx) sees the
  // same up-to-date preset. designSystem: Clean must strip surface-lumen/soft.
  // uiSurfaceStyle: persist-mirror changes (migrate / palette) re-stamp the
  // XOR classes without waiting for a theme toggle.
  useEffect(() => {
    if (!loaded) return
    applyAccent(state.preset, state.hex)
    applySurfaceStyle(uiSurfaceStyle)
  }, [resolvedTheme, loaded, designSystem, uiSurfaceStyle])

  const setAccentPreset = useCallback((next: AccentPreset) => {
    if (!state.loaded) return
    setState({ preset: next })
    applyAccent(next, state.hex)
    void setSetting('theme_accent_preset', next)
  }, [])

  const setSurfaceStyle = useCallback((next: SurfaceStyle) => {
    if (!state.loaded) return
    setState({ surfaceStyle: next })
    applySurfaceStyle(next)
    useUiStore.getState().setSurfaceStyle(next)
    void setSetting('theme_surface_style', next)
  }, [])

  const setAccentHex = useCallback((nextHex: string) => {
    if (!state.loaded) return
    setState({ preset: 'custom', hex: nextHex })
    applyAccent('custom', nextHex)
    void setSetting('theme_accent_hex', nextHex)
    void setSetting('theme_accent_preset', 'custom')
  }, [])

  const setFontFamily = useCallback((family: FontFamily) => {
    if (!state.loaded) return
    // Each font keeps its own remembered size + contrast. If the user has
    // never tweaked this family, fall back to its per-font default size and
    // the global contrast default.
    //
    // We intentionally do NOT write the fallback values into the override
    // map on a plain family switch — only explicit setFontSize /
    // setFontContrast calls create override entries. This way, if
    // DEFAULT_FONT_SIZE_BY_FAMILY is ever retuned, un-customised users
    // automatically inherit the new default for that font.
    //
    // Switching TO 'custom' without a configured custom slot is a no-op.
    // The UI is expected to open the picker modal instead (see
    // AppearanceSettings) and only persist the slot once a download
    // succeeds — so this callback never lands in a half-configured state.
    if (family === 'custom' && !state.customGoogleFontFamily) {
      return
    }
    const nextSize = sizeForFamily(family, state.sizeOverrides)
    const nextContrast = contrastForFamily(family, state.contrastOverrides)
    setState({ font: family, fontSize: nextSize, fontContrast: nextContrast })
    if (family === 'custom' && state.customGoogleFontFamily) {
      applyFont('custom', state.customGoogleFontFamily, state.customGoogleFontWeight)
    } else {
      applyFont(family)
    }
    applyFontSize(nextSize)
    applyFontContrast(nextContrast)
    void setSetting('theme_font_family', family)
  }, [])

  /**
   * Configure the Custom Google Font slot after a successful download.
   * Injects the runtime `@font-face`, swaps CSS variables, persists all
   * three keys, and flips the active font to 'custom'.
   */
  const setCustomGoogleFont = useCallback(
    async (familyName: string, weight: number, localPath: string) => {
      if (!state.loaded) return
      loadCustomGoogleFont(familyName, weight, convertFileSrc(localPath))
      applyFont('custom', familyName, weight)
      const nextSize = sizeForFamily('custom', state.sizeOverrides)
      const nextContrast = contrastForFamily('custom', state.contrastOverrides)
      applyFontSize(nextSize)
      applyFontContrast(nextContrast)
      setState({
        font: 'custom',
        fontSize: nextSize,
        fontContrast: nextContrast,
        customGoogleFontFamily: familyName,
        customGoogleFontWeight: weight,
        customGoogleFontLocalPath: localPath,
      })
      // Persist slot keys FIRST, then flip `theme_font_family` to 'custom'
      // LAST. If any slot write fails, we never end up with
      // `theme_font_family === 'custom'` paired with a half-written slot,
      // which `ensureLoaded` would otherwise treat as "slot invalid →
      // fall back to default font". Sequential awaits guarantee ordering.
      await setSetting(KEY_CUSTOM_FAMILY, familyName)
      await setSetting(KEY_CUSTOM_WEIGHT, String(weight))
      await setSetting(KEY_CUSTOM_LOCAL_PATH, localPath)
      await setSetting('theme_font_family', 'custom')
    },
    [],
  )

  /**
   * Clear the Custom Google Font slot — used by the "Clear cached fonts"
   * button when the cache files we depended on have been deleted. Drops the
   * injected `<style>`, deletes all 3 persistence keys, and falls back to
   * the default font.
   */
  const resetCustomFont = useCallback(async () => {
    if (!state.loaded) return
    unloadCustomGoogleFont()
    setState({
      customGoogleFontFamily: null,
      customGoogleFontWeight: 400,
      customGoogleFontLocalPath: null,
    })
    await Promise.all([
      deleteSetting(KEY_CUSTOM_FAMILY),
      deleteSetting(KEY_CUSTOM_WEIGHT),
      deleteSetting(KEY_CUSTOM_LOCAL_PATH),
    ])
    // Only switch off 'custom' if it was the active selection — leave
    // other selections alone (user may have already moved to e.g.
    // 'inter' before clearing the cache).
    if (state.font === 'custom') {
      const family = DEFAULT_FONT_FAMILY
      const nextSize = sizeForFamily(family, state.sizeOverrides)
      const nextContrast = contrastForFamily(family, state.contrastOverrides)
      setState({ font: family, fontSize: nextSize, fontContrast: nextContrast })
      applyFont(family)
      applyFontSize(nextSize)
      applyFontContrast(nextContrast)
      await setSetting('theme_font_family', family)
    }
  }, [])

  const setFontSize = useCallback((px: number) => {
    // Guard against writes before ensureLoaded() resolves. Without this, an
    // early click on +/- would persist an overrides blob built from the empty
    // initial map, clobbering the persisted entries of other fonts.
    if (!state.loaded) return
    const next = clampFontSize(px)
    const nextOverrides: FontOverrides = { ...state.sizeOverrides, [state.font]: next }
    setState({ fontSize: next, sizeOverrides: nextOverrides })
    applyFontSize(next)
    void setSetting('theme_font_size_overrides', JSON.stringify(nextOverrides))
  }, [])

  const setFontContrast = useCallback((v: number) => {
    if (!state.loaded) return
    const next = clampFontContrast(v)
    const nextOverrides: FontOverrides = { ...state.contrastOverrides, [state.font]: next }
    setState({ fontContrast: next, contrastOverrides: nextOverrides })
    applyFontContrast(next)
    void setSetting('theme_font_contrast_overrides', JSON.stringify(nextOverrides))
  }, [])

  return {
    accentPreset: preset,
    accentHex: hex,
    surfaceStyle,
    fontFamily: font,
    fontSize,
    fontContrast,
    customGoogleFontFamily: state.customGoogleFontFamily,
    customGoogleFontWeight: state.customGoogleFontWeight,
    setAccentPreset,
    setAccentHex,
    setSurfaceStyle,
    setFontFamily,
    setFontSize,
    setFontContrast,
    setCustomGoogleFont,
    resetCustomFont,
    loaded,
  }
}

// Boot-time only: loads settings and re-applies accent on theme toggle.
// Subscribes to the same module state as useThemeCustomization, so user
// edits in Settings are visible here and the accent is never reverted to a
// stale boot snapshot when the theme toggles.
export function useThemeInit(): void {
  const { resolvedTheme } = useTheme()
  const designSystem = useUiStore((s) => s.designSystem)
  const uiSurfaceStyle = useUiStore((s) => s.surfaceStyle)
  const { loaded } = useAccentState()

  // Initial hydration is driven by `App.tsx` via `reloadThemeSettings()`
  // once the SQLCipher unlock swap has completed — calling `ensureLoaded()`
  // here would race the real-DB read against the `:memory:` placeholder and
  // freeze the frontend on placeholder-derived defaults. App.tsx is the
  // single source of truth for *when* the read happens.

  useEffect(() => {
    if (!loaded) return
    applyAccent(state.preset, state.hex)
    applySurfaceStyle(uiSurfaceStyle)
  }, [resolvedTheme, loaded, designSystem, uiSurfaceStyle])
}

// Test-only: reset the module state so each test starts clean.
export function __resetThemeAccentStateForTests(): void {
  // Drop any DOM-injected <style> from a prior test — module state alone
  // doesn't capture it, so without this, tests using loadCustomGoogleFont
  // leak between cases.
  unloadCustomGoogleFont()
  state = {
    preset: DEFAULTS.accentPreset,
    hex: DEFAULTS.accentHex,
    surfaceStyle: DEFAULTS.surfaceStyle,
    font: DEFAULTS.fontFamily,
    fontSize: DEFAULTS.fontSize,
    fontContrast: DEFAULTS.fontContrast,
    sizeOverrides: {},
    contrastOverrides: {},
    customGoogleFontFamily: null,
    customGoogleFontWeight: 400,
    customGoogleFontLocalPath: null,
    loaded: false,
  }
  listeners.clear()
  loadPromise = null
}
