import { useCallback } from 'react'

import { createSettingHook } from './createSettingHook'

const setting = createSettingHook({
  key: 'editor_right_to_left_enabled',
  defaultValue: false,
  parse: (raw) => raw === 'true' || raw === '1',
  logLabel: 'useEditorRightToLeftEnabled',
})

/** Read the writing direction preference from the encrypted settings store. */
export const hydrateEditorRightToLeftEnabled = setting.hydrate

export const isEditorRightToLeftHydrated = setting.isHydrated

export function useEditorRightToLeftEnabled(): boolean {
  return setting.useValue()
}

export function useEditorRightToLeftHydrated(): boolean {
  return setting.useHydrated()
}

/** Non-reactive read — for command palette and non-React callers. */
export const getEditorRightToLeftEnabled = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setEditorRightToLeftEnabled = setting.setValue

export function useEditorRightToLeftSetting() {
  const rightToLeftEnabled = useEditorRightToLeftEnabled()

  const setRightToLeftEnabled = useCallback(
    (next: boolean) => setEditorRightToLeftEnabled(next),
    [],
  )

  return { rightToLeftEnabled, setRightToLeftEnabled, hydrated: isEditorRightToLeftHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetEditorRightToLeftEnabledForTests = setting.reset
