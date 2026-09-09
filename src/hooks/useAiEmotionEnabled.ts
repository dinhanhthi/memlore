import { useAiSettingsProbe } from './useAiSettingsProbe'

/**
 * Read-only probe for the `ai_emotion_suggestions_enabled` flag.
 *
 * The EmotionPicker remounts on every open (it's conditionally
 * rendered in `EditorPanel`), so a one-shot `useEffect(_, [])` is
 * sufficient — the probe re-runs at every open. The optional `gate`
 * parameter is retained for callers that mount the consuming
 * component once and need explicit re-probing (mirrors
 * `useAiSemanticEnabled`'s gate semantics).
 *
 * Returns `null` while the first probe is in flight so the chip can
 * render a neutral state instead of flashing in/out for a frame.
 */
export function useAiEmotionEnabled(gate?: unknown): boolean | null {
  return useAiSettingsProbe((s) => s.emotionSuggestionsEnabled, gate)
}
