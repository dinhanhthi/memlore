import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
  setAiFeature: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useChatRagEnabled } from './useChatRagEnabled'
import { useAiSettingsStore } from '../stores/aiSettingsStore'
import type { AIFullSettings } from '../types/ai'

const FULL: AIFullSettings = {
  provider: null,
  endpoint: null,
  endpointClass: null,
  chatModel: null,
  embeddingModel: null,
  hasApiKey: false,
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
  periodicReviewEnabled: false,
  insightsEnabled: false,
  dashboardInsightsEnabled: false,
  tagSuggestionsEnabled: false,
  chatRagEnabled: false,
  titleSuggestionsSystemPrompt: '',
  entryHighlightsSystemPrompt: '',
  multiEntrySummarySystemPrompt: '',
  goDeeperSystemPrompt: '',
  dailyChatPersona: '',
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
  useAiSettingsStore.setState({
    hydrated: false,
    chatRagEnabled: false,
    inflightHydrate: null,
  })
  vi.mocked(tauri.getAiSettings).mockReset()
  vi.mocked(tauri.setAiFeature).mockReset()
})

describe('useChatRagEnabled', () => {
  it('reflects the store value once hydrated, live', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, chatRagEnabled: true })
    const { result } = renderHook(() => useChatRagEnabled())

    expect(result.current.enabled).toBeNull()
    await waitFor(() => expect(result.current.enabled).toBe(true))

    act(() => {
      useAiSettingsStore.getState().setFlag('chat_rag', false)
    })
    expect(result.current.enabled).toBe(false)
  })

  it('leaves the store unchanged when the write rejects', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, chatRagEnabled: false })
    // `invoke()` rejects with the raw Rust `Result<_, String>` payload —
    // a bare string, not an `Error` instance.
    vi.mocked(tauri.setAiFeature).mockRejectedValueOnce('AI_NOT_CONFIGURED')
    const { result } = renderHook(() => useChatRagEnabled())
    await waitFor(() => expect(result.current.enabled).toBe(false))

    await act(async () => {
      await expect(result.current.setEnabled(true)).rejects.toThrow()
    })

    expect(useAiSettingsStore.getState().chatRagEnabled).toBe(false)
    expect(result.current.enabled).toBe(false)
  })

  it('surfaces the rejection code to the caller, prefixed or bare', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, chatRagEnabled: false })
    vi.mocked(tauri.setAiFeature).mockRejectedValueOnce('AI_PRIVACY_NOT_ACCEPTED')
    const { result } = renderHook(() => useChatRagEnabled())
    await waitFor(() => expect(result.current.enabled).toBe(false))

    await expect(result.current.setEnabled(true)).rejects.toThrow(/^AI_PRIVACY_NOT_ACCEPTED$/)

    // A wrapper-prefixed message must collapse to the same bare code —
    // not just contain it as a substring — so T5.6 can key off `.message`
    // directly, the same contract `extractAiErrorCode` gives every sibling.
    vi.mocked(tauri.setAiFeature).mockRejectedValueOnce('AI_PROVIDER_ERROR: AI_NOT_CONFIGURED')
    await expect(result.current.setEnabled(true)).rejects.toThrow(/^AI_NOT_CONFIGURED$/)
  })

  it('writes through setAiFeature then mirrors into the store on success', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, chatRagEnabled: false })
    vi.mocked(tauri.setAiFeature).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useChatRagEnabled())
    await waitFor(() => expect(result.current.enabled).toBe(false))

    await act(async () => {
      await result.current.setEnabled(true)
    })

    expect(tauri.setAiFeature).toHaveBeenCalledWith('chat_rag', true)
    expect(result.current.enabled).toBe(true)
  })
})
