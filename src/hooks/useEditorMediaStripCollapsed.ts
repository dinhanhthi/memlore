import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

/** Default collapsed — user can expand; preference persists once toggled. */
const DEFAULT_COLLAPSED = true

/** Absent / unknown setting → default collapsed. Explicit 'false'/'0' expands. */
function parseCollapsed(raw: string | null): boolean {
  if (raw === null || raw === '') return DEFAULT_COLLAPSED
  if (raw === 'false' || raw === '0') return false
  return raw === 'true' || raw === '1'
}

const setting = createSettingHook({
  key: 'editor_media_strip_collapsed',
  defaultValue: DEFAULT_COLLAPSED,
  parse: parseCollapsed,
  logLabel: 'useEditorMediaStripCollapsed',
  ignoreHydrateAfterUserWrite: true,
})

/**
 * Read `editor_media_strip_collapsed` from SQLite. Called after DB unlock so the
 * preference reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateEditorMediaStripCollapsed = setting.hydrate

export const isEditorMediaStripCollapsedHydrated = setting.isHydrated

export function useEditorMediaStripCollapsed(): boolean {
  return setting.useValue()
}

export function useEditorMediaStripCollapsedHydrated(): boolean {
  return setting.useHydrated()
}

export const getEditorMediaStripCollapsed = setting.get

export const setEditorMediaStripCollapsed = setting.setValue

export function useEditorMediaStripCollapsedSetting() {
  const mediaStripCollapsed = useEditorMediaStripCollapsed()
  const hydrated = useEditorMediaStripCollapsedHydrated()

  const setMediaStripCollapsed = useCallback(async (next: boolean) => {
    await setEditorMediaStripCollapsed(next)
  }, [])

  return { mediaStripCollapsed, setMediaStripCollapsed, hydrated }
}

/** Test-only: reset module state between cases. */
export const __resetEditorMediaStripCollapsedForTests = setting.reset
