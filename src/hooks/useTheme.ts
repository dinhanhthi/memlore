import { useEffect } from 'react'
import { coerceTheme, useUiStore } from '../stores/uiStore'
import { lightModeAllowed } from '../lib/designSystem'

/**
 * Theme integration hook — owns the document `.dark` class.
 *
 * Persistence: theme is saved to localStorage by Zustand `persist` middleware
 * on `uiStore`. We do NOT round-trip to the Tauri backend here — the previous
 * `getSetting('theme')` path raced with user clicks on cold start (a fast
 * radio-button click was silently overwritten by the deferred backend read).
 * Single source of truth = localStorage + Zustand.
 *
 * When the active design system + surface does not allow light mode,
 * `resolvedTheme` is forced to `'dark'` regardless of the stored preference
 * (Signature + lumen is dark-only). Clean and Signature Deep/Soft (while
 * `LIGHT_MODE_ENABLED`) resolve the stored `'light'` / `'dark'` preference
 * directly. Clean + a stored lumen surface still allows light.
 *
 * Returns `theme` (stored `'light'` | `'dark'`), `resolvedTheme`
 * (always concrete 'light'|'dark'), `setTheme`, and `toggleTheme`.
 */
export function useTheme() {
  const { theme: storedTheme, toggleTheme, setTheme, designSystem, surfaceStyle } = useUiStore()
  // Persist can briefly rehydrate a legacy `'system'` value before
  // `coerceTheme` runs on the store. Treat it as dark so we do not drop
  // the `.dark` class and flash Signature/Clean light.
  const theme = coerceTheme(storedTheme)

  // When the active design system + surface does not allow light mode,
  // force dark regardless of the stored preference (this also overrides
  // any leftover persisted `'light'` value under Signature + lumen).
  const lightAllowed = lightModeAllowed(designSystem, surfaceStyle)
  const resolvedTheme: 'light' | 'dark' = !lightAllowed ? 'dark' : theme

  // DOM side effect only — updates the html class to match resolvedTheme.
  // No setState here, so this is the exact pattern set-state-in-effect allows.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  return {
    theme,
    resolvedTheme,
    toggleTheme,
    setTheme,
  }
}
