import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIProvidersConfig, ProviderCredential } from '../types/ai'
import { resetAiSettingsStore, useAiSettingsStore } from '../stores/aiSettingsStore'
import { useUiStore } from '../stores/uiStore'
import { cacheAiCredentials, cacheReadyOnDevice, isAiFeatureActionable } from './aiFeatureAccessors'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./tauri', () => ({
  setAiFeature: vi.fn(),
  setDailyChatAiTitle: vi.fn(),
  setPersonaEnabled: vi.fn(),
}))

const ON_DEVICE_LLM: AIProvidersConfig = {
  generation: {
    provider: 'on-device-llm',
    endpoint: '',
    endpointClass: 'on-device',
    chatModel: 'gemma-3-4b',
    hasApiKey: false,
  },
  image: null,
  embedding: null,
}

const ON_DEVICE_EMBED: AIProvidersConfig = {
  generation: null,
  image: null,
  embedding: {
    provider: 'on-device',
    endpoint: '',
    endpointClass: 'on-device',
    embeddingModel: 'multilingual-e5-base',
    hasApiKey: false,
  },
}

const HOSTED_GEN: AIProvidersConfig = {
  generation: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    chatModel: 'gpt-5-mini',
    hasApiKey: true,
  },
  image: null,
  embedding: null,
}

const OPENAI_CRED: ProviderCredential = {
  presetId: 'openai',
  endpoint: 'https://api.openai.com/v1',
  hasApiKey: true,
  endpointClass: 'remote',
}

function seedProviders(
  providers: AIProvidersConfig,
  privacyAcceptedAt: number | null = null,
): void {
  useAiSettingsStore.setState({
    hydrated: true,
    providersHydrated: true,
    privacyAcceptedAt,
    providers,
  })
}

beforeEach(() => {
  resetAiSettingsStore()
  useUiStore.setState({ addedProviders: [] })
  cacheAiCredentials([])
  cacheReadyOnDevice('embed', false)
  cacheReadyOnDevice('llm', false)
})

describe('cacheReadyOnDevice / isAiFeatureActionable', () => {
  it('keeps an on-device-llm generation feature unactionable until a model is ready', () => {
    seedProviders(ON_DEVICE_LLM)
    expect(isAiFeatureActionable('go_deeper')).toBe(false)
  })

  it('makes an on-device-llm generation feature actionable after llm readiness is cached', () => {
    seedProviders(ON_DEVICE_LLM)
    cacheReadyOnDevice('llm', true)
    expect(isAiFeatureActionable('go_deeper')).toBe(true)
  })

  it('does not treat embed readiness as llm readiness', () => {
    seedProviders(ON_DEVICE_LLM)
    cacheReadyOnDevice('embed', true)
    expect(isAiFeatureActionable('go_deeper')).toBe(false)
  })

  it('keeps an on-device embedding feature unactionable until a model is ready', () => {
    seedProviders(ON_DEVICE_EMBED)
    expect(isAiFeatureActionable('semantic_search')).toBe(false)
  })

  it('makes an on-device embedding feature actionable after embed readiness is cached', () => {
    seedProviders(ON_DEVICE_EMBED)
    cacheReadyOnDevice('embed', true)
    expect(isAiFeatureActionable('semantic_search')).toBe(true)
  })

  it('does not treat llm readiness as embed readiness', () => {
    seedProviders(ON_DEVICE_EMBED)
    cacheReadyOnDevice('llm', true)
    expect(isAiFeatureActionable('semantic_search')).toBe(false)
  })

  it('leaves a hosted generation slot actionable even when on-device readiness is false', () => {
    seedProviders(HOSTED_GEN, 1)
    cacheAiCredentials([OPENAI_CRED])
    expect(isAiFeatureActionable('go_deeper')).toBe(true)
  })
})

const ON_DEVICE_BOTH: AIProvidersConfig = {
  generation: ON_DEVICE_LLM.generation,
  image: null,
  embedding: ON_DEVICE_EMBED.embedding,
}

describe('isAiFeatureActionable chat_rag dual-ready', () => {
  beforeEach(() => {
    seedProviders(ON_DEVICE_BOTH)
  })

  it('keeps chat_rag unactionable until both on-device slots are ready', () => {
    expect(isAiFeatureActionable('chat_rag')).toBe(false)
  })

  it('does not treat llm-only readiness as enough for chat_rag', () => {
    cacheReadyOnDevice('llm', true)
    expect(isAiFeatureActionable('chat_rag')).toBe(false)
  })

  it('does not treat embed-only readiness as enough for chat_rag', () => {
    cacheReadyOnDevice('embed', true)
    expect(isAiFeatureActionable('chat_rag')).toBe(false)
  })

  it('makes chat_rag actionable only when both llm and embed are ready', () => {
    cacheReadyOnDevice('llm', true)
    cacheReadyOnDevice('embed', true)
    expect(isAiFeatureActionable('chat_rag')).toBe(true)
  })
})
