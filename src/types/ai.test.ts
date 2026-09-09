import { describe, expect, it } from 'vitest'
import {
  AI_FEATURE_USAGE_META,
  EMBEDDING_DEPENDENT_FEATURES,
  PROVIDER_PRESETS,
  getFeatureUsageMeta,
  isHighUsageRisk,
} from './ai'
import type { AIFeature } from './ai'

const HIGH_RISK_FEATURES: AIFeature[] = [
  'daily_chat',
  'image_generation',
  'multi_entry_summary',
  'periodic_review',
  'theme_insights',
  'dashboard_insights',
  'chat_rag',
]

const LOW_RISK_FEATURES: AIFeature[] = [
  'semantic_search',
  'emotion_suggestions',
  'title_suggestions',
  'entry_highlights',
  'tag_suggestions',
  'continue_writing',
  'chat_memory',
]

describe('AI_FEATURE_USAGE_META', () => {
  it('flags every entry-count/conversation/image-scaling feature as high risk', () => {
    for (const feature of HIGH_RISK_FEATURES) {
      expect(isHighUsageRisk(feature)).toBe(true)
    }
  })

  it('does not flag single-call, cached, or single-entry features as high risk', () => {
    for (const feature of LOW_RISK_FEATURES) {
      expect(isHighUsageRisk(feature)).toBe(false)
    }
  })

  it('marks go_deeper and user_memory as medium risk (single entry/work, not fanning out)', () => {
    const MEDIUM_RISK_FEATURES: AIFeature[] = ['go_deeper', 'user_memory']
    for (const feature of MEDIUM_RISK_FEATURES) {
      expect(getFeatureUsageMeta(feature).usageRisk).toBe('medium')
      expect(isHighUsageRisk(feature)).toBe(false)
    }
  })

  it('every high-risk feature scales with something other than a single fixed call', () => {
    for (const feature of HIGH_RISK_FEATURES) {
      expect(getFeatureUsageMeta(feature).scalesWith).not.toBe('none')
    }
  })

  it('scales multi-entry features with entry_count', () => {
    const ENTRY_COUNT_FEATURES: AIFeature[] = [
      'multi_entry_summary',
      'periodic_review',
      'theme_insights',
      'dashboard_insights',
      'chat_rag',
    ]
    for (const feature of ENTRY_COUNT_FEATURES) {
      expect(getFeatureUsageMeta(feature).scalesWith).toBe('entry_count')
    }
  })

  it('scales daily_chat with conversation_length, not entry_count', () => {
    expect(getFeatureUsageMeta('daily_chat').scalesWith).toBe('conversation_length')
  })

  it('scales image_generation with image_request', () => {
    expect(getFeatureUsageMeta('image_generation').scalesWith).toBe('image_request')
  })

  it('has metadata for every AIFeature id with a non-empty callPattern', () => {
    for (const meta of Object.values(AI_FEATURE_USAGE_META)) {
      expect(meta.callPattern.length).toBeGreaterThan(0)
      expect(['low', 'medium', 'high']).toContain(meta.usageRisk)
    }
  })
})

describe('EMBEDDING_DEPENDENT_FEATURES', () => {
  // AI_FEATURE_USAGE_META is a Record<AIFeature, ...>, so its keys are the
  // runtime list of every valid AIFeature id.
  const ALL_AI_FEATURES = Object.keys(AI_FEATURE_USAGE_META)

  it('is non-empty', () => {
    expect(EMBEDDING_DEPENDENT_FEATURES.length).toBeGreaterThan(0)
  })

  it('contains only valid AIFeature ids', () => {
    for (const feature of EMBEDDING_DEPENDENT_FEATURES) {
      expect(ALL_AI_FEATURES).toContain(feature)
    }
  })

  it('matches the backend-derived set: semantic_search, emotion_suggestions, chat_rag', () => {
    expect([...EMBEDDING_DEPENDENT_FEATURES].sort()).toEqual(
      ['chat_rag', 'emotion_suggestions', 'semantic_search'].sort(),
    )
  })

  it('excludes features that only use the generation slot', () => {
    const generationOnlyFeatures: AIFeature[] = [
      'title_suggestions',
      'entry_highlights',
      'go_deeper',
      'continue_writing',
      'chat_memory',
      'daily_chat',
      'image_generation',
      'multi_entry_summary',
      'periodic_review',
      'theme_insights',
      'dashboard_insights',
      'tag_suggestions',
    ]
    for (const feature of generationOnlyFeatures) {
      expect(EMBEDDING_DEPENDENT_FEATURES).not.toContain(feature)
    }
  })
})

describe('hosted provider model presets', () => {
  it('offers only the approved OpenAI chat models in the requested order', () => {
    const openai = PROVIDER_PRESETS.find((preset) => preset.id === 'openai')

    expect(openai?.chatModelSuggestions?.map(({ value }) => value)).toEqual([
      'gpt-5-mini',
      'gpt-5.5',
      'gpt-5.5-pro',
    ])
  })

  it('configures xAI for Grok 4.5 chat and Grok Imagine image generation', () => {
    const xai = PROVIDER_PRESETS.find((preset) => preset.id === 'xai')

    expect({
      capabilities: xai?.capabilities,
      chatModel: xai?.chatModel,
      chatModels: xai?.chatModelSuggestions?.map(({ value }) => value),
      imageModel: xai?.imageModel,
      imageModels: xai?.imageModelSuggestions?.map(({ value }) => value),
    }).toEqual({
      capabilities: ['chat', 'image'],
      chatModel: 'grok-4.5',
      chatModels: ['grok-4.5'],
      imageModel: 'grok-imagine-image-quality',
      imageModels: ['grok-imagine-image-quality'],
    })
  })
})
