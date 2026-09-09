import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook({
  key: 'editor_fixed_title_enabled',
  defaultValue: false,
  parse: (raw) => raw === 'true' || raw === '1',
  logLabel: 'useEditorFixedTitleEnabled',
})

/**
 * Read `editor_fixed_title_enabled` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateEditorFixedTitleEnabled = setting.hydrate

export const isEditorFixedTitleHydrated = setting.isHydrated

export function useEditorFixedTitleEnabled(): boolean {
  return setting.useValue()
}

export function useEditorFixedTitleHydrated(): boolean {
  return setting.useHydrated()
}

export const getEditorFixedTitleEnabled = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setEditorFixedTitleEnabled = setting.setValue

export function useEditorFixedTitleSetting() {
  const fixedTitleEnabled = useEditorFixedTitleEnabled()

  const setFixedTitleEnabled = useCallback((next: boolean) => setEditorFixedTitleEnabled(next), [])

  return { fixedTitleEnabled, setFixedTitleEnabled, hydrated: isEditorFixedTitleHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetEditorFixedTitleEnabledForTests = setting.reset
