import type { ThemeInsightsPhase } from '../../hooks/useThemeInsights'
import type { ThemeInsightsResult } from '../../types/ai'

/** Displayed insights: ready wins; else last in-session generate; else cache-on-mount. */
export function pickThemeInsightsResult(
  phase: ThemeInsightsPhase,
  cached: ThemeInsightsResult | null | undefined,
  previousReady: ThemeInsightsResult | null = null,
): ThemeInsightsResult | null {
  if (phase.kind === 'ready') return phase.result
  return previousReady ?? cached ?? null
}

export type ThemeInsightsCta = 'generate' | 'regenerate' | 'compact'

/** `true` → `generate(true)` (force provider). Compact uses regenerate only once a result is shown. */
export function themeInsightsRegenerateFlag(cta: ThemeInsightsCta, hasResult: boolean): boolean {
  if (cta === 'generate') return false
  if (cta === 'regenerate') return true
  return hasResult
}
