import { useAiFeatureEnabled } from './useAiFeatureEnabled'

/** Returns whether dashboard insights are enabled in Settings → AI. */
export function useAiDashboardInsightsEnabled(): boolean | null {
  return useAiFeatureEnabled('dashboard_insights')
}
