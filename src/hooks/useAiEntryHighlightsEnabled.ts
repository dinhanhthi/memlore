import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Read-only probe for the `ai_entry_highlights_enabled` flag (Phase 6
 * v2 R7). Subscribes to `useAiSettingsStore`, which is the single source
 * of truth across the app:
 *
 * - `null` while the first hydration is in flight (so the card can
 *   render a neutral state instead of flashing).
 * - `true` when the flag is on.
 * - `false` otherwise (flag missing or explicitly off).
 *
 * The Settings → AI panel calls `useAiSettingsStore.setFlag()` after a
 * successful `setAiFeature` IPC, so toggling the flag from settings
 * updates this hook's value live — no re-mount required.
 */
export function useAiEntryHighlightsEnabled(): boolean | null {
  return useAiFeatureEnabled('entry_highlights')
}
