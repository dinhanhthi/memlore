/**
 * Pure helpers for the onboarding AI features stage (master toggle +
 * integrated-model background download kickoff). Kept out of the `.tsx`
 * so Vitest can cover them without component tests.
 */
import { EMBEDDING_DEPENDENT_FEATURES, type AIFeature, type AIFullSettings } from '../types/ai'

/** Features offered during onboarding — mirrored from `AIStep` so tests and
 *  the UI share one list. Keep in sync with `ONBOARDING_FEATURES` in AIStep
 *  if that constant is re-exported later; for now AIStep imports this. */
export const ONBOARDING_FEATURES: readonly AIFeature[] = [
  'semantic_search',
  'emotion_suggestions',
  'title_suggestions',
  'entry_highlights',
  'tag_suggestions',
  'go_deeper',
  'continue_writing',
  'daily_chat',
  'chat_memory',
  'image_generation',
  'multi_entry_summary',
  'periodic_review',
  'theme_insights',
]

export function isFeatureEnabled(settings: AIFullSettings | null, feature: AIFeature): boolean {
  if (!settings) return false
  switch (feature) {
    case 'semantic_search':
      return settings.semanticSearchEnabled
    case 'emotion_suggestions':
      return settings.emotionSuggestionsEnabled
    case 'title_suggestions':
      return settings.titleSuggestionsEnabled
    case 'entry_highlights':
      return settings.entryHighlightsEnabled
    case 'go_deeper':
      return settings.goDeeperEnabled
    case 'continue_writing':
      return settings.continueWritingEnabled
    case 'daily_chat':
      return settings.dailyChatEnabled
    case 'chat_memory':
      return settings.chatMemoryEnabled
    case 'image_generation':
      return settings.imageGenerationEnabled
    case 'multi_entry_summary':
      return settings.multiEntrySummaryEnabled
    case 'periodic_review':
      return settings.periodicReviewEnabled
    case 'theme_insights':
      return settings.insightsEnabled
    case 'dashboard_insights':
      return settings.dashboardInsightsEnabled
    case 'tag_suggestions':
      return settings.tagSuggestionsEnabled
    case 'chat_rag':
      return settings.chatRagEnabled
    case 'user_memory':
      return settings.userMemoryEnabled
  }
}

/** Features the onboarding list cannot turn on yet (missing embedding /
 *  image model). The master "all features" toggle only flips the rest. */
export function isFeatureUnavailable(feature: AIFeature, embeddingConfigured: boolean): boolean {
  const needsEmbedding = EMBEDDING_DEPENDENT_FEATURES.includes(feature) && !embeddingConfigured
  const needsImageModel = feature === 'image_generation'
  return needsEmbedding || needsImageModel
}

/**
 * Which onboarding features the master toggle should write for a given
 * `next` value.
 * - enable: every listed feature that is available and currently off
 * - disable: every listed feature that is currently on (including ones
 *   that became unavailable later — leave nothing half-enabled)
 */
export function masterToggleTargets(
  features: readonly AIFeature[],
  next: boolean,
  embeddingConfigured: boolean,
  enabled: (feature: AIFeature) => boolean,
): AIFeature[] {
  if (next) {
    return features.filter((f) => !isFeatureUnavailable(f, embeddingConfigured) && !enabled(f))
  }
  return features.filter((f) => enabled(f))
}

/** Whether Continue should kick a background on-device model download.
 *  Skip when already on disk or already in flight. */
export function shouldKickOnDeviceDownload(
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error' | undefined,
): boolean {
  return status !== 'ready' && status !== 'downloading'
}

/** Prefix used by `setFeatures` when some writes succeeded before a failure. */
export const PARTIAL_FEATURE_UPDATE_PREFIX = 'PARTIAL_FEATURE_UPDATE:'

export function formatPartialFeatureUpdateError(
  applied: number,
  total: number,
  cause: string,
): string {
  return `${PARTIAL_FEATURE_UPDATE_PREFIX}${applied}/${total}:${cause}`
}

export function parsePartialFeatureUpdateError(
  message: string,
): { applied: number; total: number; cause: string } | null {
  if (!message.startsWith(PARTIAL_FEATURE_UPDATE_PREFIX)) return null
  const rest = message.slice(PARTIAL_FEATURE_UPDATE_PREFIX.length)
  const match = /^(\d+)\/(\d+):(.*)$/s.exec(rest)
  if (!match) return null
  return {
    applied: Number(match[1]),
    total: Number(match[2]),
    cause: match[3],
  }
}
