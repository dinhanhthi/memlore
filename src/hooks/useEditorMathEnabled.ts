import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook({
  key: 'editor_math_enabled',
  defaultValue: false,
  parse: (raw) => raw === 'true' || raw === '1',
  logLabel: 'useEditorMathEnabled',
})

/**
 * Read `editor_math_enabled` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateEditorMathEnabled = setting.hydrate

/** Whether the math setting has been read from SQLite at least once. */
export const isEditorMathHydrated = setting.isHydrated

export function useEditorMathEnabled(): boolean {
  return setting.useValue()
}

/** True once `editor_math_enabled` has been read from SQLite (or hydration failed). */
export function useEditorMathHydrated(): boolean {
  return setting.useHydrated()
}

/** Non-reactive read — for TipTap extension callbacks outside React. */
export const getEditorMathEnabled = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setEditorMathEnabled = setting.setValue

export function useEditorMathSetting() {
  const mathEnabled = useEditorMathEnabled()

  const setMathEnabled = useCallback((next: boolean) => setEditorMathEnabled(next), [])

  return { mathEnabled, setMathEnabled, hydrated: isEditorMathHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetEditorMathEnabledForTests = setting.reset
