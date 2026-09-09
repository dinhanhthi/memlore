import { getSetting, setSetting } from '../lib/tauri'
import { usePersistedSetting } from './usePersistedSetting'

const SETTING_KEY = 'ai_show_message_meta'

/** Default-on: unset / anything other than the string `'false'` → true. */
function parseBoolDefaultOn(raw: string | null | undefined): boolean {
  return raw !== 'false'
}

// ── Module-level cache for imperative (non-React) access ──────────────
let cachedShowMeta = true
let showMetaHydrated = false

/** Hydrate the module cache from SQLite. Safe to call multiple times. */
export async function hydrateShowMessageMeta(): Promise<void> {
  try {
    cachedShowMeta = parseBoolDefaultOn(await getSetting(SETTING_KEY))
    showMetaHydrated = true
  } catch {
    // Leave default.
  }
}

/** Non-reactive read — for command palette and non-React callers. */
export function getShowMessageMeta(): boolean {
  return cachedShowMeta
}

export function isShowMessageMetaHydrated(): boolean {
  return showMetaHydrated
}

/** Imperative setter — for command palette and non-React callers. */
export async function setShowMessageMetaImperative(next: boolean): Promise<void> {
  await setSetting(SETTING_KEY, next ? 'true' : 'false')
  cachedShowMeta = next
  showMetaHydrated = true
}

/**
 * Reads + writes `ai_show_message_meta` — **on by default**. When on, Daily
 * Daily Chat shows the ℹ️ affordance on assistant replies that carry
 * model metadata. The metadata is always persisted; this only gates display.
 */
export function useShowMessageMeta(): {
  showMessageMeta: boolean
  loading: boolean
  setShowMessageMeta: (next: boolean) => Promise<void>
} {
  const {
    value: showMessageMeta,
    loading,
    setValue: setShowMessageMeta,
  } = usePersistedSetting({
    key: SETTING_KEY,
    defaultValue: true,
    parse: parseBoolDefaultOn,
    onLoad: (parsed) => {
      cachedShowMeta = parsed
      showMetaHydrated = true
    },
    onPersist: (next) => {
      cachedShowMeta = next
    },
  })

  return { showMessageMeta, loading, setShowMessageMeta }
}
