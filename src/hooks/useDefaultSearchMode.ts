import { getSetting, setSetting } from '../lib/tauri'
import { usePersistedSetting } from './usePersistedSetting'

export type SearchMode = 'keyword' | 'meaning'

const SETTING_KEY = 'default_search_mode'
const DEFAULT_MODE: SearchMode = 'keyword'

function parseMode(raw: string | null | undefined): SearchMode {
  return raw === 'meaning' ? 'meaning' : 'keyword'
}

// ── Module-level cache for imperative (non-React) access ──────────────
let cachedMode: SearchMode = DEFAULT_MODE
let searchModeHydrated = false

/** Hydrate the module cache from SQLite. Safe to call multiple times. */
export async function hydrateDefaultSearchMode(): Promise<void> {
  try {
    cachedMode = parseMode(await getSetting(SETTING_KEY))
    searchModeHydrated = true
  } catch {
    // Leave default.
  }
}

/** Non-reactive read — for command palette and non-React callers. */
export function getDefaultSearchMode(): SearchMode {
  return cachedMode
}

export function isDefaultSearchModeHydrated(): boolean {
  return searchModeHydrated
}

/** Imperative setter — for command palette and non-React callers. */
export async function setDefaultSearchModeImperative(next: SearchMode): Promise<void> {
  await setSetting(SETTING_KEY, next)
  cachedMode = next
  searchModeHydrated = true
}

/**
 * Reads + writes the user's preferred default search mode (keyword
 * vs meaning). The SearchOverlay seeds from this only when the user
 * has not toggled overlay mode this session; the AI Settings panel
 * exposes a toggle so power users who prefer semantic search can
 * flip the default.
 *
 * - `mode` is `'keyword'` until the first SQLite read resolves; the
 *   overlay's eager-open path can therefore render immediately
 *   without flickering through a "loading" state.
 * - `setMode` persists optimistically then refreshes from disk on
 *   error so a failed write doesn't strand the UI in a fake state.
 */
export function useDefaultSearchMode(): {
  mode: SearchMode
  loading: boolean
  setMode: (next: SearchMode) => Promise<void>
} {
  const {
    value: mode,
    loading,
    setValue: setMode,
  } = usePersistedSetting({
    key: SETTING_KEY,
    defaultValue: DEFAULT_MODE,
    parse: parseMode,
    onLoad: (parsed) => {
      cachedMode = parsed
      searchModeHydrated = true
    },
    onPersist: (next) => {
      cachedMode = next
    },
  })

  return { mode, loading, setMode }
}
