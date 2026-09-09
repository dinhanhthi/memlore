import { useCallback } from 'react'
import { createSettingHook } from './createSettingHook'

export type MediaViewMode = 'full' | 'panel'

export function parseMediaViewMode(raw: string | null): MediaViewMode {
  return raw === 'panel' ? 'panel' : 'full'
}

const setting = createSettingHook<MediaViewMode>({
  key: 'media_view_mode',
  defaultValue: 'full',
  parse: parseMediaViewMode,
  serialize: (mode) => mode,
  logLabel: 'useMediaViewMode',
})

/**
 * Read `media_view_mode` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateMediaViewMode = setting.hydrate

export function useMediaViewMode(): MediaViewMode {
  return setting.useValue()
}

export function useMediaViewModeHydrated(): boolean {
  return setting.useHydrated()
}

export const getMediaViewMode = setting.get

/** Imperative setter — for command palette and non-React callers. */
export const setMediaViewMode = setting.setValue

export function useMediaViewModeSetting() {
  const mediaViewMode = useMediaViewMode()

  const setMediaViewModeInHook = useCallback((next: MediaViewMode) => setMediaViewMode(next), [])

  return { mediaViewMode, setMediaViewMode: setMediaViewModeInHook, hydrated: setting.isHydrated() }
}

/** Test-only: reset module state between cases. */
export const __resetMediaViewModeForTests = setting.reset
