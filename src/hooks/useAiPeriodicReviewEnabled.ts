import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/**
 * Returns whether periodic reviews are enabled in Settings → AI.
 * `null` while the store is still hydrating.
 */
export function useAiPeriodicReviewEnabled(): boolean | null {
  return useAiFeatureEnabled('periodic_review')
}
