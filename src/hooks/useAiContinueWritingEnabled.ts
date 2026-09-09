import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Read-only probe for the `ai_continue_writing_enabled` flag — AI prose
 * writing inside the editor.
 *
 * Same contract as `useAiGoDeeperEnabled`:
 *
 * - `null` while the first hydration is in flight, so the button renders
 *   nothing instead of flashing in and out.
 * - `true` when the flag is on.
 * - `false` otherwise.
 *
 * Gates BOTH editor-prose actions — the footer's continuation button and
 * the bubble menu's Rewrite — matching the single backend gate in
 * `editor_prose_inner`.
 */
export function useAiContinueWritingEnabled(): boolean | null {
  return useAiFeatureEnabled('continue_writing')
}
