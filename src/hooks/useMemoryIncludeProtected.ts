import { getSetting, setSetting } from '../lib/tauri'
import { usePersistedSetting } from './usePersistedSetting'

const SETTING_KEY = 'ai_memory_include_protected'

function parseBool(raw: string | null | undefined): boolean {
  return raw === 'true'
}

// ── Module-level cache for imperative (non-React) access ──────────────
let cachedIncludeProtected = false
let includeProtectedHydrated = false

/** Hydrate the module cache from SQLite. Safe to call multiple times. */
export async function hydrateMemoryIncludeProtected(): Promise<void> {
  try {
    cachedIncludeProtected = parseBool(await getSetting(SETTING_KEY))
    includeProtectedHydrated = true
  } catch {
    // Leave default.
  }
}

/** Non-reactive read — for command palette and non-React callers. */
export function getMemoryIncludeProtected(): boolean {
  return cachedIncludeProtected
}

export function isMemoryIncludeProtectedHydrated(): boolean {
  return includeProtectedHydrated
}

/** Imperative setter — for command palette and non-React callers. */
export async function setMemoryIncludeProtectedImperative(next: boolean): Promise<void> {
  await setSetting(SETTING_KEY, next ? 'true' : 'false')
  cachedIncludeProtected = next
  includeProtectedHydrated = true
}

/**
 * Reads + writes `ai_memory_include_protected` — off by default. When on,
 * locked journal entries become eligible for memory extraction and persona
 * style sampling. Invisible entries are ALWAYS excluded regardless of this
 * setting.
 *
 * Deliberately a SEPARATE key/hook from `useEmbedIncludeProtected`
 * (`ai_embed_include_protected`) — memory extraction and background
 * embedding are different subsystems with different consent surfaces, and
 * coupling them would silently opt one into the other.
 */
export function useMemoryIncludeProtected(): {
  includeProtected: boolean
  loading: boolean
  setIncludeProtected: (next: boolean) => Promise<void>
} {
  const {
    value: includeProtected,
    loading,
    setValue: setIncludeProtected,
  } = usePersistedSetting({
    key: SETTING_KEY,
    defaultValue: false,
    parse: parseBool,
    onLoad: (parsed) => {
      cachedIncludeProtected = parsed
      includeProtectedHydrated = true
    },
    onPersist: (next) => {
      cachedIncludeProtected = next
    },
  })

  return { includeProtected, loading, setIncludeProtected }
}
