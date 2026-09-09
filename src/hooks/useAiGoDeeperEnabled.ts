import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Read-only probe for the `ai_go_deeper_enabled` flag (Phase 6 v2 R8).
 * Subscribes to `useAiSettingsStore`, which is the single source of
 * truth across the app:
 *
 * - `null` while the first hydration is in flight (so the button can
 *   render nothing instead of flashing in/out).
 * - `true` when the flag is on.
 * - `false` otherwise (flag missing or explicitly off).
 *
 * The Settings → AI panel calls `useAiSettingsStore.setFlag()` after a
 * successful `setAiFeature` IPC, so toggling the flag from settings
 * updates this hook's value live — no re-mount required.
 */
export function useAiGoDeeperEnabled(): boolean | null {
  return useAiFeatureEnabled('go_deeper')
}
