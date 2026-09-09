import { useEffect } from 'react'
import { useUiStore } from '../stores/uiStore'
import { applyCornerRadius, applyDesignSystem, lightModeAllowed } from '../lib/designSystem'
import { applySurfaceStyle } from '../lib/themeColors'

/**
 * Design-system integration hook — owns the document `ds-*` root class
 * (`ds-signature` / `ds-clean` / `ds-clay`) so the token-override layer
 * can key off it, stamps `surface-*` from the persisted uiStore mirror
 * so the lock screen tracks Lumen/Soft before SQLCipher unlock, and
 * stamps `rad-*` (`rad-medium` / `rad-high`; low stamps nothing) from
 * the Clean-only corner-radius setting.
 *
 * Persistence: `designSystem`, `surfaceStyle`, and `cornerRadius` are
 * saved to localStorage by Zustand `persist` middleware on `uiStore`.
 * This hook is a DOM side effect only — no setState in the effect,
 * matching `useTheme`.
 *
 * Returns `designSystem` (stored value), `setDesignSystem`,
 * `cornerRadius`, `setCornerRadius`, and `lightAllowed` (whether the
 * active system+surface may resolve to light).
 */
export function useDesignSystem() {
  const designSystem = useUiStore((s) => s.designSystem)
  const surfaceStyle = useUiStore((s) => s.surfaceStyle)
  const cornerRadius = useUiStore((s) => s.cornerRadius)
  const setDesignSystem = useUiStore((s) => s.setDesignSystem)
  const setCornerRadius = useUiStore((s) => s.setCornerRadius)

  useEffect(() => {
    applyDesignSystem(designSystem)
    applySurfaceStyle(surfaceStyle)
    applyCornerRadius(cornerRadius)
  }, [designSystem, surfaceStyle, cornerRadius])

  return {
    designSystem,
    setDesignSystem,
    cornerRadius,
    setCornerRadius,
    lightAllowed: lightModeAllowed(designSystem, surfaceStyle),
  }
}
