import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Read-only probe for the `ai_multi_entry_summary_enabled` flag.
 *
 * Backed by the shared `aiSettingsStore` so mounting many
 * `<AiSummaryTrigger.Root>` instances on the same view (3 sections in
 * On This Day, 3 buckets in All Entries) only triggers a single
 * `getAiSettings()` IPC round-trip — `hydrate()` dedupes via the
 * in-flight promise.
 *
 * Returns `null` while the store is still hydrating so callers can
 * distinguish "loading" from "explicitly off" and avoid a UI flicker
 * (no false-then-true flash when the toggle is actually on).
 */
export function useAiMultiEntrySummaryEnabled(): boolean | null {
  return useAiFeatureEnabled('multi_entry_summary')
}
