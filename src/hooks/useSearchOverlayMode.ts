import { useCallback, useState } from 'react'
import type { SearchMode } from './useDefaultSearchMode'

/**
 * Last overlay-toggle choice for this app session. Null until the user
 * flips the SearchOverlay toggle; Settings `default_search_mode` seeds
 * until then. Not written to SQLite — Settings owns that key.
 */
let sessionOverride: SearchMode | null = null

/**
 * Session-scoped search-overlay mode. Settings → AI owns
 * `default_search_mode`; this hook only remembers the last toggle
 * inside the overlay for the current app session so close/reopen
 * restores it. Meaning still falls back to keyword when semantic
 * search is disabled.
 */
export function useSearchOverlayMode(
  defaultMode: SearchMode,
  defaultLoading: boolean,
  semanticEnabled: boolean | null,
): {
  mode: SearchMode
  activeMode: SearchMode
  setMode: (next: SearchMode) => void
} {
  const [modeOverride, setModeOverride] = useState<SearchMode | null>(sessionOverride)
  const baseMode: SearchMode =
    !defaultLoading && defaultMode === 'meaning' && semanticEnabled !== false
      ? 'meaning'
      : 'keyword'
  const mode: SearchMode = modeOverride ?? baseMode
  const activeMode: SearchMode = semanticEnabled === false && mode === 'meaning' ? 'keyword' : mode

  const setMode = useCallback((next: SearchMode) => {
    sessionOverride = next
    setModeOverride(next)
  }, [])

  return { mode, activeMode, setMode }
}

/** Test-only: reset module state between cases. */
export function __resetSearchOverlayModeForTests(): void {
  sessionOverride = null
}
