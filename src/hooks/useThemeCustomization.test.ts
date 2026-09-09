import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import {
  getSurfaceStyle,
  reloadThemeSettings,
  setSurfaceStyleImperative,
  useThemeCustomization,
  useThemeInit,
  __resetThemeAccentStateForTests,
} from './useThemeCustomization'
import { applyDesignSystem } from '../lib/designSystem'
import { useUiStore } from '../stores/uiStore'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${p}`),
}))

// Real pure functions (clampFontSize, clampFontContrast, defaultFontSizeFor,
// FONT_* constants) are kept via vi.importActual so a change to limits or
// per-font defaults in themeColors.ts can't silently drift away from what
// these tests assert against. Only the DOM-touching applyX functions are
// stubbed.
vi.mock('../lib/themeColors', async () => {
  const actual = await vi.importActual<typeof import('../lib/themeColors')>('../lib/themeColors')
  return {
    ...actual,
    applyAccent: vi.fn(),
    applySurfaceStyle: vi.fn(),
    applyFont: vi.fn(),
    applyFontSize: vi.fn(),
    applyFontContrast: vi.fn(),
    loadCustomGoogleFont: vi.fn(),
    unloadCustomGoogleFont: vi.fn(),
  }
})

let mockResolvedTheme: 'light' | 'dark' = 'light'
vi.mock('./useTheme', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme, isDark: mockResolvedTheme === 'dark' }),
}))

import * as tauri from '../lib/tauri'
import * as themeColors from '../lib/themeColors'

const mockGetSetting = tauri.getSetting as ReturnType<typeof vi.fn>
const mockApplyAccent = themeColors.applyAccent as ReturnType<typeof vi.fn>
const mockApplySurfaceStyle = themeColors.applySurfaceStyle as ReturnType<typeof vi.fn>
const mockApplyFont = themeColors.applyFont as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  __resetThemeAccentStateForTests()
  useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'deep' })
  mockResolvedTheme = 'light'
  mockGetSetting.mockImplementation((key: string) => {
    const map: Record<string, string> = {
      theme_accent_preset: 'rose',
      theme_accent_hex: '#f43f5e',
      theme_font_family: 'inter',
      theme_font_size_overrides: JSON.stringify({ inter: 17 }),
      theme_font_contrast_overrides: JSON.stringify({ inter: 0.85 }),
    }
    return Promise.resolve(map[key] ?? null)
  })
})

// In production, hydration is driven by `App.tsx` via `reloadThemeSettings`
// once the SQLCipher unlock swap has completed. Hooks no longer self-hydrate
// at mount. Tests simulate that by kicking off the same call before reading
// state.
async function triggerLoad(): Promise<void> {
  await act(async () => {
    await reloadThemeSettings()
  })
}

describe('useThemeCustomization', () => {
  it('loads settings on mount and applies them', async () => {
    const { result } = renderHook(() => useThemeCustomization())

    await triggerLoad()

    expect(result.current.accentPreset).toBe('rose')
    expect(result.current.accentHex).toBe('#f43f5e')
    expect(result.current.fontFamily).toBe('inter')
    expect(mockApplyAccent).toHaveBeenCalledWith('rose', '#f43f5e')
    expect(mockApplyFont).toHaveBeenCalledWith('inter')
  })

  it('falls back to defaults when settings are null', async () => {
    mockGetSetting.mockResolvedValue(null)

    const { result } = renderHook(() => useThemeCustomization())

    await triggerLoad()

    expect(result.current.accentPreset).toBe('sky')
    expect(result.current.accentHex).toBe('#0ea5e9')
    expect(result.current.fontFamily).toBe('nunito')
  })

  it('falls back to Sky when the persisted accent preset is unknown', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'theme_accent_preset') return Promise.resolve('amber')
      return Promise.resolve(null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.accentPreset).toBe('sky')
    expect(result.current.accentHex).toBe('#0ea5e9')
    expect(mockApplyAccent).toHaveBeenCalledWith('sky', '#0ea5e9')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_accent_preset', 'sky')
  })

  it('setAccentPreset updates state, calls applyAccent, and persists', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    act(() => {
      result.current.setAccentPreset('sky')
    })

    expect(result.current.accentPreset).toBe('sky')
    expect(mockApplyAccent).toHaveBeenCalledWith('sky', '#f43f5e')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_accent_preset', 'sky')
  })

  it('setAccentHex sets preset to custom, updates state, and persists both keys', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    act(() => {
      result.current.setAccentHex('#123456')
    })

    expect(result.current.accentPreset).toBe('custom')
    expect(result.current.accentHex).toBe('#123456')
    expect(mockApplyAccent).toHaveBeenCalledWith('custom', '#123456')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_accent_hex', '#123456')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_accent_preset', 'custom')
  })

  it('defaults surfaceStyle to "deep" when unset and applies it on load', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    // The default mockGetSetting map has no theme_surface_style key → SuperX deep.
    expect(result.current.surfaceStyle).toBe('deep')
    expect(useUiStore.getState().surfaceStyle).toBe('deep')
    expect(mockApplySurfaceStyle).toHaveBeenCalledWith('deep')
  })

  it('loads a persisted "soft" surfaceStyle (explicit lift) and applies it', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = { theme_surface_style: 'soft' }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.surfaceStyle).toBe('soft')
    expect(useUiStore.getState().surfaceStyle).toBe('soft')
    expect(mockApplySurfaceStyle).toHaveBeenCalledWith('soft')
  })

  it('loads a persisted "lumen" surfaceStyle and backfills uiStore', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = { theme_surface_style: 'lumen' }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.surfaceStyle).toBe('lumen')
    expect(useUiStore.getState().surfaceStyle).toBe('lumen')
    expect(mockApplySurfaceStyle).toHaveBeenCalledWith('lumen')
  })

  it("leftover sqlite 'soft' does not clobber migrated uiStore lumen", async () => {
    useUiStore.setState({ surfaceStyle: 'lumen' })
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = { theme_surface_style: 'soft' }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.surfaceStyle).toBe('lumen')
    expect(useUiStore.getState().surfaceStyle).toBe('lumen')
    expect(mockApplySurfaceStyle).toHaveBeenCalledWith('lumen')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_surface_style', 'lumen')
  })

  it('setSurfaceStyle updates state, calls applySurfaceStyle, dual-writes uiStore + sqlite', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    act(() => {
      result.current.setSurfaceStyle('soft')
    })

    expect(result.current.surfaceStyle).toBe('soft')
    expect(useUiStore.getState().surfaceStyle).toBe('soft')
    expect(mockApplySurfaceStyle).toHaveBeenLastCalledWith('soft')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_surface_style', 'soft')
  })

  it('getSurfaceStyle reads uiStore, not the module default', () => {
    useUiStore.setState({ surfaceStyle: 'lumen' })
    expect(getSurfaceStyle()).toBe('lumen')
  })

  it('setSurfaceStyleImperative dual-writes uiStore + sqlite and applies', () => {
    setSurfaceStyleImperative('lumen')
    expect(useUiStore.getState().surfaceStyle).toBe('lumen')
    expect(getSurfaceStyle()).toBe('lumen')
    expect(mockApplySurfaceStyle).toHaveBeenCalledWith('lumen')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_surface_style', 'lumen')
  })

  it('setFontFamily switches to the new family and uses its per-font default when no override exists', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    act(() => {
      result.current.setFontFamily('nunito')
    })

    expect(result.current.fontFamily).toBe('nunito')
    expect(mockApplyFont).toHaveBeenCalledWith('nunito')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_font_family', 'nunito')
    // Nunito has no override in the mocked DB, so falls back to per-font default 15.
    expect(result.current.fontSize).toBe(15)
    // Contrast falls back to FONT_CONTRAST_DEFAULT (0.8) for an un-tweaked family.
    expect(result.current.fontContrast).toBe(0.8)
  })

  it('setFontSize clamps to FONT_SIZE_MIN..FONT_SIZE_MAX and persists per-font overrides', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    act(() => result.current.setFontSize(5))
    expect(result.current.fontSize).toBe(10) // clamped to FONT_SIZE_MIN
    // Initial family is "inter" (from mocked theme_font_family); override map
    // keeps inter's existing entry replaced with the clamped value.
    expect(tauri.setSetting).toHaveBeenCalledWith(
      'theme_font_size_overrides',
      JSON.stringify({ inter: 10 }),
    )

    act(() => result.current.setFontSize(99))
    expect(result.current.fontSize).toBe(21) // clamped to FONT_SIZE_MAX
    expect(tauri.setSetting).toHaveBeenCalledWith(
      'theme_font_size_overrides',
      JSON.stringify({ inter: 21 }),
    )
  })

  it('setFontContrast clamps to FONT_CONTRAST_MIN..MAX and persists per-font overrides', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    act(() => result.current.setFontContrast(0.1))
    const themeColorsReal =
      await vi.importActual<typeof import('../lib/themeColors')>('../lib/themeColors')
    expect(result.current.fontContrast).toBe(themeColorsReal.FONT_CONTRAST_MIN)

    act(() => result.current.setFontContrast(2))
    expect(result.current.fontContrast).toBe(themeColorsReal.FONT_CONTRAST_MAX)
    expect(tauri.setSetting).toHaveBeenLastCalledWith(
      'theme_font_contrast_overrides',
      JSON.stringify({ inter: themeColorsReal.FONT_CONTRAST_MAX }),
    )
  })

  it('loads persisted fontSize and fontContrast on mount from per-font overrides', async () => {
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.fontSize).toBe(17) // from mocked override map for "inter"
    expect(result.current.fontContrast).toBe(0.85) // from mocked override map for "inter"
  })

  it('normalizes removed playpen-sans to nunito and persists', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_font_family: 'playpen-sans',
      }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.fontFamily).toBe('nunito')
    expect(mockApplyFont).toHaveBeenCalledWith('nunito')
    expect(tauri.setSetting).toHaveBeenCalledWith('theme_font_family', 'nunito')
  })

  // Regression: stale keys from removed fonts (e.g. jetbrains-mono, removed
  // in commit 2a03d9c) must not survive a load → save round-trip. Without
  // the allowlist they'd be re-serialised on every setFontSize call and
  // accumulate in the JSON blob indefinitely.
  it('drops unknown font keys when parsing persisted overrides', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_font_family: 'inter',
        theme_font_size_overrides: JSON.stringify({
          inter: 17,
          'jetbrains-mono': 16, // removed font
          'totally-fake': 99, // never existed
        }),
      }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    // Trigger a write so we can inspect what gets persisted.
    act(() => result.current.setFontSize(18))

    expect(tauri.setSetting).toHaveBeenCalledWith(
      'theme_font_size_overrides',
      JSON.stringify({ inter: 18 }),
    )
  })

  // Regression for the per-font persistence bug: editing size/contrast for
  // font A then switching to font B then back to A must restore A's edits,
  // not the per-font default.
  it('preserves per-font size and contrast across font-family switches', async () => {
    mockGetSetting.mockResolvedValue(null) // start clean — no persisted overrides
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    // Default font is nunito (per-font default 15).
    act(() => result.current.setFontFamily('inter'))
    expect(result.current.fontFamily).toBe('inter')
    expect(result.current.fontSize).toBe(14) // inter's per-font default

    // User customises inter.
    act(() => result.current.setFontSize(19))
    act(() => result.current.setFontContrast(0.75))
    expect(result.current.fontSize).toBe(19)
    expect(result.current.fontContrast).toBe(0.75)

    // Switch to nunito — its per-font default kicks in because nunito has no
    // override yet.
    act(() => result.current.setFontFamily('nunito'))
    expect(result.current.fontSize).toBe(15)
    expect(result.current.fontContrast).toBe(0.8)

    // Switch back to inter — the user's edits must come back.
    act(() => result.current.setFontFamily('inter'))
    expect(result.current.fontSize).toBe(19)
    expect(result.current.fontContrast).toBe(0.75)
  })

  // Regression: when both useThemeInit (mounted in App.tsx) and
  // useThemeCustomization (mounted in SettingsPanel) are alive at the same
  // time, changing the accent in Settings then toggling dark/light must NOT
  // revert the accent to the value useThemeInit captured at boot.
  it('preserves the latest accent when both hooks re-apply on theme toggle', async () => {
    // Boot DB has rose persisted.
    const init = renderHook(() => useThemeInit())
    const settings = renderHook(() => useThemeCustomization())
    await triggerLoad()

    // User opens Settings and switches to sky.
    act(() => {
      settings.result.current.setAccentPreset('sky')
    })
    expect(mockApplyAccent).toHaveBeenLastCalledWith('sky', '#f43f5e')

    // User toggles dark mode — both hooks observe resolvedTheme change.
    mockApplyAccent.mockClear()
    act(() => {
      mockResolvedTheme = 'dark'
      init.rerender()
      settings.rerender()
    })

    // Every applyAccent call triggered by the theme change must use the
    // current preset ("sky"), never the boot snapshot ("rose" or default
    // "violet"). Previously useThemeInit ignored later setAccentPreset calls
    // and re-applied a stale value, overwriting the correct one.
    const presetsApplied = mockApplyAccent.mock.calls.map((c) => c[0])
    expect(presetsApplied.length).toBeGreaterThan(0)
    for (const preset of presetsApplied) {
      expect(preset).toBe('sky')
    }
  })
})

describe('useThemeCustomization — Custom Google Font slot', () => {
  const mockSetSetting = tauri.setSetting as ReturnType<typeof vi.fn>
  const mockDeleteSetting = tauri.deleteSetting as ReturnType<typeof vi.fn>
  const mockLoadCustomGoogleFont = themeColors.loadCustomGoogleFont as ReturnType<typeof vi.fn>
  const mockUnloadCustomGoogleFont = themeColors.unloadCustomGoogleFont as ReturnType<typeof vi.fn>

  it('hydrates the custom font slot from persisted settings', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_font_family: 'custom',
        theme_custom_google_font_family: 'Merriweather',
        theme_custom_google_font_weight: '700',
        theme_custom_google_font_local_path: '/path/to/font.woff2',
      }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.fontFamily).toBe('custom')
    expect(result.current.customGoogleFontFamily).toBe('Merriweather')
    expect(result.current.customGoogleFontWeight).toBe(700)
    expect(mockLoadCustomGoogleFont).toHaveBeenCalledWith(
      'Merriweather',
      700,
      'asset://localhost//path/to/font.woff2',
    )
    expect(mockApplyFont).toHaveBeenCalledWith('custom', 'Merriweather', 700)
  })

  it('falls back to default font when font=custom but custom keys are missing', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_font_family: 'custom',
        // No custom_google_font_* keys — slot is invalid.
      }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    // The default font (nunito) takes over.
    expect(result.current.fontFamily).toBe('nunito')
    expect(result.current.customGoogleFontFamily).toBeNull()
    expect(mockApplyFont).toHaveBeenCalledWith('nunito')
    expect(mockLoadCustomGoogleFont).not.toHaveBeenCalled()
  })

  it('rejects custom slot when weight cannot be parsed', async () => {
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_font_family: 'custom',
        theme_custom_google_font_family: 'Merriweather',
        theme_custom_google_font_weight: 'not-a-number',
        theme_custom_google_font_local_path: '/path/to/font.woff2',
      }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(result.current.fontFamily).toBe('nunito')
    expect(result.current.customGoogleFontFamily).toBeNull()
  })

  it('setCustomGoogleFont injects @font-face, applies CSS vars, and persists all 3 keys', async () => {
    mockGetSetting.mockResolvedValue(null)
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    await act(async () => {
      await result.current.setCustomGoogleFont('Roboto Slab', 500, '/cache/roboto-slab.woff2')
    })

    expect(mockLoadCustomGoogleFont).toHaveBeenCalledWith(
      'Roboto Slab',
      500,
      'asset://localhost//cache/roboto-slab.woff2',
    )
    expect(mockApplyFont).toHaveBeenCalledWith('custom', 'Roboto Slab', 500)
    expect(result.current.fontFamily).toBe('custom')
    expect(result.current.customGoogleFontFamily).toBe('Roboto Slab')
    expect(result.current.customGoogleFontWeight).toBe(500)

    const persistedKeys = mockSetSetting.mock.calls.map((c) => c[0])
    expect(persistedKeys).toContain('theme_font_family')
    expect(persistedKeys).toContain('theme_custom_google_font_family')
    expect(persistedKeys).toContain('theme_custom_google_font_weight')
    expect(persistedKeys).toContain('theme_custom_google_font_local_path')
  })

  it('resetCustomFont removes <style>, deletes 3 keys, and falls back to default when active', async () => {
    // Boot with a custom font active.
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_font_family: 'custom',
        theme_custom_google_font_family: 'Merriweather',
        theme_custom_google_font_weight: '400',
        theme_custom_google_font_local_path: '/m.woff2',
      }
      return Promise.resolve(map[key] ?? null)
    })

    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()
    expect(result.current.fontFamily).toBe('custom')

    await act(async () => {
      await result.current.resetCustomFont()
    })

    expect(mockUnloadCustomGoogleFont).toHaveBeenCalled()
    expect(result.current.customGoogleFontFamily).toBeNull()
    expect(result.current.fontFamily).toBe('nunito')

    const deletedKeys = mockDeleteSetting.mock.calls.map((c) => c[0])
    expect(deletedKeys).toContain('theme_custom_google_font_family')
    expect(deletedKeys).toContain('theme_custom_google_font_weight')
    expect(deletedKeys).toContain('theme_custom_google_font_local_path')
  })

  it('setFontFamily(custom) is a no-op when the custom slot is empty', async () => {
    mockGetSetting.mockResolvedValue(null)
    const { result } = renderHook(() => useThemeCustomization())
    await triggerLoad()

    const initialFont = result.current.fontFamily
    mockApplyFont.mockClear()

    act(() => {
      result.current.setFontFamily('custom')
    })

    // Font selection unchanged; applyFont not called for the bogus switch.
    expect(result.current.fontFamily).toBe(initialFont)
    expect(mockApplyFont).not.toHaveBeenCalled()
  })
})

// Regression: switching to Clean must re-run applyAccent / applySurfaceStyle
// even when `resolvedTheme` is unchanged. Without `designSystem` in those
// effects' deps, Signature's inline glow and `.surface-soft` leak until an
// unrelated theme toggle happens to re-apply. `useTheme` is mocked so flipping
// the store cannot change `resolvedTheme` through it — that's the point.
// useDesignSystem is not mounted here, so the test stamps `ds-*` itself;
// production App.tsx runs useDesignSystem before these hooks.
describe('re-apply on designSystem change (real CSS)', () => {
  const spikeGlow = '0 0 0 1px rgb(251 146 60 / 0.3), 0 8px 20px rgb(251 146 60 / 0.2)'

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../lib/themeColors')>('../lib/themeColors')
    mockApplyAccent.mockImplementation(actual.applyAccent)
    mockApplySurfaceStyle.mockImplementation(actual.applySurfaceStyle)
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    applyDesignSystem('signature')
    useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'deep' })
    mockGetSetting.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        theme_accent_preset: 'orange',
        theme_surface_style: 'soft',
      }
      return Promise.resolve(map[key] ?? null)
    })
  })

  afterEach(() => {
    cleanup()
    mockApplyAccent.mockReset()
    mockApplySurfaceStyle.mockReset()
    document.documentElement.style.cssText = ''
    document.documentElement.classList.remove(
      'ds-clean',
      'ds-signature',
      'ds-lumen',
      'surface-soft',
      'surface-lumen',
    )
    useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'deep' })
  })

  function glow(): string {
    return document.documentElement.style.getPropertyValue('--shadow-primary-glow').trim()
  }

  function flipToCleanWithoutTouchingTheme(): void {
    act(() => {
      applyDesignSystem('clean')
      useUiStore.setState({ designSystem: 'clean' })
    })
  }

  function flipToLumenWithoutTouchingTheme(): void {
    act(() => {
      applyDesignSystem('signature')
      useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'lumen' })
    })
  }

  function restoreLoadedSoftSurface(): void {
    act(() => {
      applyDesignSystem('signature')
      useUiStore.setState({ designSystem: 'signature', surfaceStyle: 'soft' })
    })
  }

  function expectOrangeGlows(): void {
    expect(glow()).toBe(spikeGlow)
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#fb923c')
    expect(document.documentElement.style.getPropertyValue('--surface-hue')).toBe('41')
    expect(document.documentElement.style.getPropertyValue('--grad-primary')).toContain('gradient')
  }

  it('useThemeCustomization re-applies accent + surface when designSystem flips without a theme toggle', async () => {
    renderHook(() => useThemeCustomization())
    await triggerLoad()

    expect(glow()).toBe(spikeGlow)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)

    flipToCleanWithoutTouchingTheme()

    expect(glow()).toBe('none')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
  })

  it('useThemeInit re-applies accent + surface when designSystem flips without a theme toggle', async () => {
    renderHook(() => useThemeInit())
    await triggerLoad()

    expect(glow()).toBe(spikeGlow)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)

    flipToCleanWithoutTouchingTheme()

    expect(glow()).toBe('none')
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
  })

  it('useThemeCustomization keeps the user accent under lumen and stamps surface-lumen on signature', async () => {
    renderHook(() => useThemeCustomization())
    await triggerLoad()

    expectOrangeGlows()
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)

    flipToLumenWithoutTouchingTheme()

    expectOrangeGlows()
    expect(document.documentElement.classList.contains('ds-signature')).toBe(true)
    expect(document.documentElement.classList.contains('ds-lumen')).toBe(false)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)

    restoreLoadedSoftSurface()

    expectOrangeGlows()
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('useThemeInit keeps the user accent under lumen and stamps surface-lumen on signature', async () => {
    renderHook(() => useThemeInit())
    await triggerLoad()

    expectOrangeGlows()
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)

    flipToLumenWithoutTouchingTheme()

    expectOrangeGlows()
    expect(document.documentElement.classList.contains('ds-signature')).toBe(true)
    expect(document.documentElement.classList.contains('ds-lumen')).toBe(false)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)

    restoreLoadedSoftSurface()

    expectOrangeGlows()
    expect(document.documentElement.classList.contains('surface-soft')).toBe(true)
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
  })

  it('useThemeCustomization strips surface-lumen when flipping to Clean', async () => {
    renderHook(() => useThemeCustomization())
    await triggerLoad()

    flipToLumenWithoutTouchingTheme()
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)

    flipToCleanWithoutTouchingTheme()

    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
  })

  it('useThemeInit strips surface-lumen when flipping to Clean', async () => {
    renderHook(() => useThemeInit())
    await triggerLoad()

    flipToLumenWithoutTouchingTheme()
    expect(document.documentElement.classList.contains('surface-lumen')).toBe(true)

    flipToCleanWithoutTouchingTheme()

    expect(document.documentElement.classList.contains('surface-lumen')).toBe(false)
    expect(document.documentElement.classList.contains('surface-soft')).toBe(false)
  })
})
