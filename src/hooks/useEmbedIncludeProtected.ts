import { usePersistedSetting } from './usePersistedSetting'

const SETTING_KEY = 'ai_embed_include_protected'

function parseBool(raw: string | null | undefined): boolean {
  return raw === 'true'
}

/**
 * Reads + writes `ai_embed_include_protected` — off by default. When on,
 * background/manual embedding also indexes locked entries (stored
 * encrypted like every other vector; sent to the configured provider
 * first if it's hosted). Invisible entries are ALWAYS excluded from
 * embedding regardless of this setting — their vectors could never be
 * surfaced anyway, since the read-side filter that excludes locked/hidden
 * entries from search results and from anything chat retrieves is always enforced.
 * This setting only controls what gets embedded, not what a query is
 * allowed to surface.
 */
export function useEmbedIncludeProtected(): {
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
  })

  return { includeProtected, loading, setIncludeProtected }
}
