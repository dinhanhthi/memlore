import { useAiSettingsProbe } from './useAiSettingsProbe'

/**
 * Read-only probe for the `title_suggestions_enabled` flag — the
 * cooked setting the backend `suggest_title` command actually gates
 * on. Mirrors `useAiMultiEntrySummaryEnabled` etc.
 *
 * Returns `null` while the first probe is in flight so callers can
 * render a neutral state instead of flashing in/out.
 */
export function useAiTitleSuggestionsEnabled(gate?: unknown): boolean | null {
  return useAiSettingsProbe((s) => s.titleSuggestionsEnabled, gate)
}
