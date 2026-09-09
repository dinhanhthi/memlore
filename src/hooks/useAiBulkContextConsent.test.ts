import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
  getAiProviders: vi.fn(),
  acceptAiBulkContext: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useAiBulkContextConsent } from './useAiBulkContextConsent'
import type { AIFullSettings } from '../types/ai'

const FULL: AIFullSettings = {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  endpointClass: 'remote',
  chatModel: 'gpt-4o-mini',
  embeddingModel: null,
  hasApiKey: true,
  privacyAcceptedAt: null,
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
  periodicReviewEnabled: true,
  insightsEnabled: false,
  dashboardInsightsEnabled: false,
  chatRagEnabled: false,
  tagSuggestionsEnabled: false,
  titleSuggestionsSystemPrompt: '',
  entryHighlightsSystemPrompt: '',
  multiEntrySummarySystemPrompt: '',
  goDeeperSystemPrompt: '',
  dailyChatPersona: 'empathetic',
  dailyChatCustomPersona: '',
  dailyChatAiTitle: false,
  responseLanguage: 'auto',
  emotionSuggestionLanguage: 'auto',
  userMemoryEnabled: false,
  personaEnabled: false,
  memoryGenProvider: null,
  memoryGenEndpoint: null,
  memoryGenEndpointClass: null,
  memoryGenChatModel: null,
  memoryGenHasApiKey: false,
  memoryEmbedProvider: null,
  memoryEmbedEndpoint: null,
  memoryEmbedEndpointClass: null,
  memoryEmbedEmbeddingModel: null,
  memoryEmbedHasApiKey: false,
}

beforeEach(() => {
  vi.mocked(tauri.getAiSettings).mockReset()
  vi.mocked(tauri.getAiProviders).mockReset()
  vi.mocked(tauri.acceptAiBulkContext).mockReset()
  vi.mocked(tauri.getAiSettings).mockResolvedValue(FULL)
  vi.mocked(tauri.getAiProviders).mockResolvedValue({
    generation: {
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      endpointClass: 'remote',
      chatModel: 'gpt-4o-mini',
      hasApiKey: true,
    },
    image: null,
    embedding: null,
  })
})

describe('useAiBulkContextConsent', () => {
  it('needsBulkConsent is false for local endpoints', async () => {
    const { result } = renderHook(() => useAiBulkContextConsent())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.needsBulkConsent('local')).toBe(false)
  })

  it('needsBulkConsent is true for remote when receipt missing', async () => {
    const { result } = renderHook(() => useAiBulkContextConsent())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.needsBulkConsent('remote')).toBe(true)
  })

  it('needsBulkConsent is false for remote after receipt exists', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({
      ...FULL,
      privacyAcceptedAt: 100,
    })
    const { result } = renderHook(() => useAiBulkContextConsent())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.needsBulkConsent('remote')).toBe(false)
  })

  it('acceptBulkContext stamps local state', async () => {
    vi.mocked(tauri.acceptAiBulkContext).mockResolvedValueOnce(200)
    const { result } = renderHook(() => useAiBulkContextConsent())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.acceptBulkContext('remote')
    })
    expect(result.current.needsBulkConsent('remote')).toBe(false)
    expect(tauri.acceptAiBulkContext).toHaveBeenCalledWith()
  })

  it('returns generation.endpointClass from getAiProviders', async () => {
    const { result } = renderHook(() => useAiBulkContextConsent())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.generationEndpointClass).toBe('remote')
  })

  it('resets generationEndpointClass to null when getAiProviders rejects', async () => {
    vi.mocked(tauri.getAiProviders).mockRejectedValueOnce(new Error('unavailable'))
    const { result } = renderHook(() => useAiBulkContextConsent())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.generationEndpointClass).toBeNull()
  })
})
