import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Returns whether AI tag suggestions are enabled.
 * `null` while the store has not hydrated yet.
 */
export function useAiTagSuggestionsEnabled(): boolean | null {
  return useAiFeatureEnabled('tag_suggestions')
}
