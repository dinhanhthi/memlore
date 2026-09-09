import { useCallback } from 'react'
import { useEditorDistractionStore } from '../stores/editorDistractionStore'
import { createSettingHook } from './createSettingHook'

function resolveEnabled(raw: string | null): boolean {
  if (raw == null || raw === '') return true
  return raw === 'true' || raw === '1'
}

/** Default on — users can hide the footer toggle in Settings → Editor. */
const setting = createSettingHook({
  key: 'editor_distraction_enabled',
  defaultValue: true,
  parse: resolveEnabled,
  logLabel: 'useEditorDistractionEnabled',
  onSet: (next) => {
    if (!next) {
      useEditorDistractionStore.getState().setDistractionMode(false)
    }
  },
})

/**
 * Read `editor_distraction_enabled` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateEditorDistractionEnabled = setting.hydrate

export const isEditorDistractionHydrated = setting.isHydrated

export function useEditorDistractionEnabled(): boolean {
  return setting.useValue()
}

export function useEditorDistractionHydrated(): boolean {
  return setting.useHydrated()
}

export const getEditorDistractionEnabled = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setEditorDistractionEnabled = setting.setValue

export function useEditorDistractionSetting() {
  const distractionEnabled = useEditorDistractionEnabled()

  const setDistractionEnabled = useCallback(
    (next: boolean) => setEditorDistractionEnabled(next),
    [],
  )

  return { distractionEnabled, setDistractionEnabled, hydrated: isEditorDistractionHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetEditorDistractionEnabledForTests = setting.reset
