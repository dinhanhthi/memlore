import { useAiSettingsProbe } from './useAiSettingsProbe'

/**
 * Read-only probe for the `ai_semantic_search_enabled` flag. Used by the
 * SearchOverlay's Meaning-tab disabled state. Returns `null` while the
 * first probe is in flight so the UI can render a neutral state instead
 * of flashing the disabled treatment for a frame.
 *
 * Re-probes whenever the `gate` value changes (typically the SearchOverlay's
 * `searchOverlayOpen` flag) so a setting toggled in the AI Settings panel
 * is reflected the next time the user opens search. Without the gate the
 * value would be cached forever — `<SearchOverlay>` mounts at app start
 * and never unmounts, so a one-shot `useEffect(..., [])` would render the
 * disabled UX permanently for users who enable semantic search after boot.
 */
export function useAiSemanticEnabled(gate?: unknown): boolean | null {
  return useAiSettingsProbe((s) => s.semanticSearchEnabled, gate)
}
