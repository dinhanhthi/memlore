import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { useAiPersonaEnabled } from './useAiPersonaEnabled'
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
    personaEnabled: false,
    userMemoryEnabled: false,
    inflightHydrate: null,
  })
  vi.mocked(tauri.getAiSettings).mockReset()
})

describe('useAiPersonaEnabled', () => {
  it('returns null while hydration is in flight', () => {
    let resolve: (v: AIFullSettings) => void = () => {}
    vi.mocked(tauri.getAiSettings).mockReturnValueOnce(
      new Promise<AIFullSettings>((r) => {
        resolve = r
      }),
    )
    const { result } = renderHook(() => useAiPersonaEnabled())
    expect(result.current).toBeNull()
    resolve(FULL)
  })

  it('returns true when persona is on after hydration', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, personaEnabled: true })
    const { result } = renderHook(() => useAiPersonaEnabled())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('re-renders when Settings flips persona after hydration', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({ ...FULL, personaEnabled: false })
    const { result } = renderHook(() => useAiPersonaEnabled())
    await waitFor(() => expect(result.current).toBe(false))
    act(() => {
      useAiSettingsStore.getState().setPersonaEnabled(true)
    })
    expect(result.current).toBe(true)
  })

  it('stays on when the User Memory master toggle is off (persona is independent)', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({
      ...FULL,
      personaEnabled: true,
      userMemoryEnabled: false,
    })
    const { result } = renderHook(() => useAiPersonaEnabled())
    await waitFor(() => expect(result.current).toBe(true))
    act(() => {
      useAiSettingsStore.getState().setFlag('user_memory', false)
    })
    expect(result.current).toBe(true)
  })
})
