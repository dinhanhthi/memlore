import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useAiContinueWritingEnabled } from './useAiContinueWritingEnabled'
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
  chatRagEnabled: false,
  tagSuggestionsEnabled: false,
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
    continueWritingEnabled: false,
    goDeeperEnabled: false,
    inflightHydrate: null,
  })
  vi.mocked(tauri.getAiSettings).mockReset()
})

describe('useAiContinueWritingEnabled', () => {
  it('returns null while hydration is in flight', () => {
    let resolve: (v: AIFullSettings) => void = () => {}
    vi.mocked(tauri.getAiSettings).mockReturnValueOnce(
      new Promise<AIFullSettings>((r) => {
        resolve = r
      }),
    )
    const { result } = renderHook(() => useAiContinueWritingEnabled())
    expect(result.current).toBeNull()
    resolve(FULL)
  })

  it('returns true when the store flag is on after hydration', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, continueWritingEnabled: true })
    const { result } = renderHook(() => useAiContinueWritingEnabled())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('returns false when the store flag is off after hydration', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, continueWritingEnabled: false })
    const { result } = renderHook(() => useAiContinueWritingEnabled())
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('re-renders when Settings flips the flag after hydration', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, continueWritingEnabled: false })
    const { result } = renderHook(() => useAiContinueWritingEnabled())
    await waitFor(() => expect(result.current).toBe(false))
    act(() => {
      useAiSettingsStore.getState().setFlag('continue_writing', true)
    })
    expect(result.current).toBe(true)
  })

  it('does not follow the go_deeper flag', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, continueWritingEnabled: false })
    const { result } = renderHook(() => useAiContinueWritingEnabled())
    await waitFor(() => expect(result.current).toBe(false))
    act(() => {
      useAiSettingsStore.getState().setFlag('go_deeper', true)
    })
    expect(result.current).toBe(false)
  })
})
