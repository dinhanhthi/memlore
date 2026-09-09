import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Read-only probe for the `ai_daily_chat_enabled` flag (Phase 6 v2 R9).
 * Subscribes to `useAiSettingsStore`, which is the single source of
 * truth across the app — same pattern as `useAiGoDeeperEnabled`:
 *
 * - `null` while the first hydration is in flight (so the Sidebar can
 *   suppress the nav item instead of flashing it in/out).
 * - `true` when the flag is on.
 * - `false` otherwise (flag missing or explicitly off).
 *
 * The Settings → AI panel calls `useAiSettingsStore.setFlag()` after a
 * successful `setAiFeature` IPC, so toggling the flag from settings
 * updates this hook's value live — no re-mount required.
 */
export function useAiDailyChatEnabled(): boolean | null {
  return useAiFeatureEnabled('daily_chat')
}
