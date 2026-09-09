import { describe, expect, it } from 'vitest'
import type { AIFeature, AIFullSettings } from '../types/ai'
import {
  formatPartialFeatureUpdateError,
  isFeatureEnabled,
  isFeatureUnavailable,
  masterToggleTargets,
  ONBOARDING_FEATURES,
  parsePartialFeatureUpdateError,
  shouldKickOnDeviceDownload,
} from './onboardingAiFeatures'

function settingsWith(overrides: Partial<AIFullSettings>): AIFullSettings {
  return {
    semanticSearchEnabled: false,
    emotionSuggestionsEnabled: false,
    titleSuggestionsEnabled: false,
    entryHighlightsEnabled: false,
    goDeeperEnabled: false,
    continueWritingEnabled: false,
    dailyChatEnabled: false,
    chatMemoryEnabled: false,
    imageGenerationEnabled: false,
    multiEntrySummaryEnabled: false,
    periodicReviewEnabled: false,
    insightsEnabled: false,
    dashboardInsightsEnabled: false,
    tagSuggestionsEnabled: false,
    chatRagEnabled: false,
    userMemoryEnabled: false,
    embeddingModel: null,
    ...overrides,
  } as AIFullSettings
}

describe('isFeatureUnavailable', () => {
  it('flags embedding-dependent features when embedding is not configured', () => {
    expect(isFeatureUnavailable('semantic_search', false)).toBe(true)
    expect(isFeatureUnavailable('emotion_suggestions', false)).toBe(true)
  })

  it('allows embedding-dependent features when embedding is configured', () => {
    expect(isFeatureUnavailable('semantic_search', true)).toBe(false)
  })

  it('always flags image_generation (onboarding never collects an image model)', () => {
    expect(isFeatureUnavailable('image_generation', true)).toBe(true)
    expect(isFeatureUnavailable('image_generation', false)).toBe(true)
  })

  it('leaves generation-only features available', () => {
    expect(isFeatureUnavailable('title_suggestions', false)).toBe(false)
    expect(isFeatureUnavailable('daily_chat', false)).toBe(false)
  })
})

describe('masterToggleTargets', () => {
  const enabled = (on: Set<AIFeature>) => (f: AIFeature) => on.has(f)

  it('when enabling, only available currently-off features', () => {
    const on = new Set<AIFeature>(['daily_chat'])
    const targets = masterToggleTargets(ONBOARDING_FEATURES, true, false, enabled(on))
    expect(targets).toContain('title_suggestions')
    expect(targets).not.toContain('daily_chat')
    expect(targets).not.toContain('semantic_search')
    expect(targets).not.toContain('image_generation')
  })

  it('when enabling with embedding configured, includes semantic_search', () => {
    const targets = masterToggleTargets(ONBOARDING_FEATURES, true, true, () => false)
    expect(targets).toContain('semantic_search')
    expect(targets).not.toContain('image_generation')
  })

  it('when disabling, every currently-on listed feature', () => {
    const on = new Set<AIFeature>(['semantic_search', 'title_suggestions', 'image_generation'])
    const targets = masterToggleTargets(ONBOARDING_FEATURES, false, false, enabled(on))
    expect(targets.sort()).toEqual(
      ['image_generation', 'semantic_search', 'title_suggestions'].sort(),
    )
  })
})

describe('shouldKickOnDeviceDownload', () => {
  it('kicks when not downloaded or error', () => {
    expect(shouldKickOnDeviceDownload(undefined)).toBe(true)
    expect(shouldKickOnDeviceDownload('not_downloaded')).toBe(true)
    expect(shouldKickOnDeviceDownload('error')).toBe(true)
  })

  it('skips when ready or already downloading', () => {
    expect(shouldKickOnDeviceDownload('ready')).toBe(false)
    expect(shouldKickOnDeviceDownload('downloading')).toBe(false)
  })
})

describe('isFeatureEnabled', () => {
  it('returns false when settings is null', () => {
    expect(isFeatureEnabled(null, 'daily_chat')).toBe(false)
  })

  it('reads the matching flag', () => {
    expect(isFeatureEnabled(settingsWith({ dailyChatEnabled: true }), 'daily_chat')).toBe(true)
    expect(isFeatureEnabled(settingsWith({ dailyChatEnabled: false }), 'daily_chat')).toBe(false)
  })

  it('reads the dashboard_insights flag', () => {
    expect(
      isFeatureEnabled(settingsWith({ dashboardInsightsEnabled: true }), 'dashboard_insights'),
    ).toBe(true)
    expect(
      isFeatureEnabled(settingsWith({ dashboardInsightsEnabled: false }), 'dashboard_insights'),
    ).toBe(false)
  })
})

describe('ONBOARDING_FEATURES', () => {
  it('does not include dashboard_insights', () => {
    expect(ONBOARDING_FEATURES).not.toContain('dashboard_insights')
  })
})

describe('partial feature update error codec', () => {
  it('round-trips applied/total/cause', () => {
    const msg = formatPartialFeatureUpdateError(3, 10, 'boom')
    expect(parsePartialFeatureUpdateError(msg)).toEqual({
      applied: 3,
      total: 10,
      cause: 'boom',
    })
  })

  it('returns null for unrelated messages', () => {
    expect(parsePartialFeatureUpdateError('network down')).toBeNull()
  })
})
