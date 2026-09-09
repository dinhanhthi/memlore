import { useEffect } from 'react'
import { getAiFeatureEnabled } from '../lib/aiFeatureAccessors'
import { useAiSettingsStore } from '../stores/aiSettingsStore'
import type { AIFeature } from '../types/ai'

type AiSettingsSnapshot = ReturnType<typeof useAiSettingsStore.getState>

/**
 * Store-backed boolean flag. `null` while `!hydrated`, else the selected
 * value. Triggers `hydrate()` on first mount if the store is empty.
 * Live-updates when Settings patches the store (`setFlag` / `setPersonaEnabled`).
 *
 * Persona is not an `AIFeature` — pass `(s) => s.personaEnabled`.
 */
export function useAiStoreFlag(select: (s: AiSettingsSnapshot) => boolean): boolean | null {
  const hydrated = useAiSettingsStore((s) => s.hydrated)
  const enabled = useAiSettingsStore(select)
  const hydrate = useAiSettingsStore((s) => s.hydrate)

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  return hydrated ? enabled : null
}

/**
 * Store-backed `AIFeature` flag via `getAiFeatureEnabled`. Same
 * `boolean | null` contract as `useAiStoreFlag`.
 */
export function useAiFeatureEnabled(feature: AIFeature): boolean | null {
  return useAiStoreFlag(() => getAiFeatureEnabled(feature))
}
