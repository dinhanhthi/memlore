import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook({
  key: 'editor_justify_enabled',
  defaultValue: false,
  parse: (raw) => raw === 'true' || raw === '1',
  logLabel: 'useEditorJustifyEnabled',
})

/**
 * Read `editor_justify_enabled` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateEditorJustifyEnabled = setting.hydrate

export const isEditorJustifyHydrated = setting.isHydrated

export function useEditorJustifyEnabled(): boolean {
  return setting.useValue()
}

export function useEditorJustifyHydrated(): boolean {
  return setting.useHydrated()
}

export const getEditorJustifyEnabled = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setEditorJustifyEnabled = setting.setValue

export function useEditorJustifySetting() {
  const justifyEnabled = useEditorJustifyEnabled()

  const setJustifyEnabled = useCallback((next: boolean) => setEditorJustifyEnabled(next), [])

  return { justifyEnabled, setJustifyEnabled, hydrated: isEditorJustifyHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetEditorJustifyEnabledForTests = setting.reset
