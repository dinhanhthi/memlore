import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/** Returns whether theme insights are enabled in Settings → AI. */
export function useAiInsightsEnabled(): boolean | null {
  return useAiFeatureEnabled('theme_insights')
}
