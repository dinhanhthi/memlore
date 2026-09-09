import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIFullSettings, AIProvidersConfig, ProviderCredential } from '../types/ai'
import { useAIProviderConfig } from './useAIProviderConfig'
import { useAiSettingsStore } from '../stores/aiSettingsStore'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
  getAiProviders: vi.fn(),
  getAiProviderCredentials: vi.fn(),
  setAiGenerationProvider: vi.fn(),
  setAiImageProvider: vi.fn(),
  setAiEmbeddingProvider: vi.fn(),
  forgetAiGenerationProvider: vi.fn(),
  forgetAiImageProvider: vi.fn(),
  forgetAiEmbeddingProvider: vi.fn(),
  forgetAiProviderCredential: vi.fn(),
  testAiGenerationProvider: vi.fn(),
  testAiEmbeddingProvider: vi.fn(),
  setAiProviderCredential: vi.fn(),
  testAiProviderCredential: vi.fn(),
  acceptAiPrivacy: vi.fn(),
  setAiFeature: vi.fn(),
  setDailyChatPreferences: vi.fn(),
  setDailyChatAiTitle: vi.fn(),
  setEmotionSuggestionLanguage: vi.fn(),
  setAiResponseLanguage: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const SETTINGS_UNCONFIGURED: AIFullSettings = {
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

const PROVIDERS: AIProvidersConfig = {
  generation: {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    endpointClass: 'remote',
    chatModel: 'gpt-5-mini',
    hasApiKey: true,
  },
  image: null,
  embedding: {
    provider: 'voyage',
    endpoint: 'https://api.voyageai.com/v1',
    endpointClass: 'remote',
    embeddingModel: 'voyage-4',
    hasApiKey: true,
  },
}

const STALE_PROVIDERS: AIProvidersConfig = {
  generation: {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    endpointClass: 'local',
    chatModel: 'stale-model',
    hasApiKey: false,
  },
  image: null,
  embedding: null,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAiSettingsStore.setState({
    hydrated: false,
    entryHighlightsEnabled: false,
    goDeeperEnabled: false,
    inflightHydrate: null,
    providersHydrated: false,
    providers: { generation: null, image: null, embedding: null },
    inflightProvidersHydrate: null,
    providerRequestSeq: 0,
  })
  vi.mocked(tauri.getAiSettings).mockResolvedValue(SETTINGS_UNCONFIGURED)
  vi.mocked(tauri.getAiProviders).mockResolvedValue({
    generation: null,
    image: null,
    embedding: null,
  })
  vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue([])
  vi.mocked(tauri.setAiFeature).mockResolvedValue(undefined)
})

describe('useAIProviderConfig', () => {
  it('starts in loading state with null settings', () => {
    const { result } = renderHook(() => useAIProviderConfig())
    expect(result.current.loading).toBe(true)
    expect(result.current.settings).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('loads settings on mount', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.settings).toEqual(SETTINGS_UNCONFIGURED)
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(1)
  })

  it('captures error when getAiSettings rejects', async () => {
    vi.mocked(tauri.getAiSettings).mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.settings).toBeNull()
    expect(result.current.error).toBe('boom')
  })

  it('updates providers when settings refresh fails and preserves the settings error', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    vi.mocked(tauri.getAiSettings).mockRejectedValueOnce(new Error('settings failed'))
    vi.mocked(tauri.getAiProviders).mockResolvedValueOnce(PROVIDERS)

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.error).toBe('settings failed')
    expect(result.current.providers).toEqual(PROVIDERS)
    expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
  })

  it('stops exposing an old provider snapshot when the latest provider refresh fails', async () => {
    vi.mocked(tauri.getAiProviders).mockResolvedValueOnce(STALE_PROVIDERS)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.providers).toEqual(STALE_PROVIDERS)

    vi.mocked(tauri.getAiProviders).mockRejectedValueOnce(new Error('provider failed'))
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.error).toBe('provider failed')
    expect(result.current.providers).toBeNull()
    expect(useAiSettingsStore.getState().providersHydrated).toBe(false)
  })

  it('live-updates providers when an external shared refresh succeeds', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    vi.mocked(tauri.getAiProviders).mockResolvedValueOnce(PROVIDERS)
    await act(async () => {
      await useAiSettingsStore.getState().refreshProviders()
    })

    expect(result.current.providers).toEqual(PROVIDERS)
  })

  it('keeps the newer shared snapshot and no error when a superseded refresh rejects', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const oldProviders = deferred<AIProvidersConfig>()
    vi.mocked(tauri.getAiProviders)
      .mockReturnValueOnce(oldProviders.promise)
      .mockResolvedValueOnce(PROVIDERS)

    let olderRefresh!: Promise<void>
    act(() => {
      olderRefresh = result.current.refresh()
    })
    await act(async () => {
      await result.current.refresh()
    })

    await act(async () => {
      oldProviders.reject(new Error('superseded failure'))
      await olderRefresh
    })

    expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
    expect(result.current.providers).toEqual(PROVIDERS)
    expect(result.current.error).toBeNull()
  })

  it('does not let an older refresh overwrite a newer provider snapshot', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const staleSettings = deferred<AIFullSettings>()
    const staleProviders = deferred<AIProvidersConfig>()
    vi.mocked(tauri.getAiSettings)
      .mockReturnValueOnce(staleSettings.promise)
      .mockResolvedValueOnce({ ...SETTINGS_UNCONFIGURED, entryHighlightsEnabled: true })
    vi.mocked(tauri.getAiProviders)
      .mockReturnValueOnce(staleProviders.promise)
      .mockResolvedValueOnce(PROVIDERS)

    let olderRefresh!: Promise<void>
    act(() => {
      olderRefresh = result.current.refresh()
    })
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.providers).toEqual(PROVIDERS)
    expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)

    await act(async () => {
      staleSettings.resolve(SETTINGS_UNCONFIGURED)
      staleProviders.resolve(STALE_PROVIDERS)
      await olderRefresh
    })

    expect(result.current.settings?.entryHighlightsEnabled).toBe(true)
    expect(result.current.providers).toEqual(PROVIDERS)
    expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
  })

  it('setFeature() forwards feature + enabled and refreshes', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setFeature('semantic_search', true)
    })

    expect(tauri.setAiFeature).toHaveBeenCalledWith('semantic_search', true)
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  it('refresh() writes the AI flags through to useAiSettingsStore (single source of truth)', async () => {
    vi.mocked(tauri.getAiSettings).mockResolvedValue({
      ...SETTINGS_UNCONFIGURED,
      entryHighlightsEnabled: true,
      goDeeperEnabled: true,
    })
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const s = useAiSettingsStore.getState()
    expect(s.hydrated).toBe(true)
    expect(s.entryHighlightsEnabled).toBe(true)
    expect(s.goDeeperEnabled).toBe(true)
  })

  it('setFeature() updates the store and the post-refresh snapshot agrees with the optimistic value', async () => {
    // Realistic backend behavior: `setAiFeature` flips the row in
    // SQLite, so the next `getAiSettings()` returns the new value.
    vi.mocked(tauri.getAiSettings)
      .mockResolvedValueOnce(SETTINGS_UNCONFIGURED)
      .mockResolvedValueOnce({ ...SETTINGS_UNCONFIGURED, entryHighlightsEnabled: true })
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(false)

    await act(async () => {
      await result.current.setFeature('entry_highlights', true)
    })

    // After IPC + refresh, both optimistic-write and refresh-write-through
    // converge on `true` — store stays the single source of truth.
    expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(true)
  })

  it('setFeature() propagates AI_PRIVACY_NOT_ACCEPTED error', async () => {
    vi.mocked(tauri.setAiFeature).mockRejectedValueOnce('AI_PRIVACY_NOT_ACCEPTED')
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      act(async () => {
        await result.current.setFeature('semantic_search', true)
      }),
    ).rejects.toBe('AI_PRIVACY_NOT_ACCEPTED')
  })

  it('setFeatures() writes every toggle then refreshes once', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const settingsCallsBefore = vi.mocked(tauri.getAiSettings).mock.calls.length

    await act(async () => {
      await result.current.setFeatures([
        { feature: 'semantic_search', enabled: true },
        { feature: 'title_suggestions', enabled: true },
      ])
    })

    expect(tauri.setAiFeature).toHaveBeenCalledWith('semantic_search', true)
    expect(tauri.setAiFeature).toHaveBeenCalledWith('title_suggestions', true)
    // One refresh after the batch (not one per feature).
    expect(vi.mocked(tauri.getAiSettings).mock.calls.length).toBe(settingsCallsBefore + 1)
  })

  it('setFeatures() on mid-batch failure refreshes and throws PARTIAL_FEATURE_UPDATE', async () => {
    vi.mocked(tauri.setAiFeature)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'))
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const settingsCallsBefore = vi.mocked(tauri.getAiSettings).mock.calls.length

    let err: unknown
    await act(async () => {
      try {
        await result.current.setFeatures([
          { feature: 'semantic_search', enabled: true },
          { feature: 'title_suggestions', enabled: true },
        ])
      } catch (e) {
        err = e
      }
    })

    expect(String(err)).toContain('PARTIAL_FEATURE_UPDATE:1/2:')
    // Refresh still runs after the partial failure so UI matches disk.
    expect(vi.mocked(tauri.getAiSettings).mock.calls.length).toBe(settingsCallsBefore + 1)
  })

  it('setDailyChatPrefs() forwards persona + custom persona (no language) and refreshes', async () => {
    vi.mocked(tauri.setDailyChatPreferences).mockResolvedValue(undefined)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setDailyChatPrefs('wise', 'custom text')
    })

    expect(tauri.setDailyChatPreferences).toHaveBeenCalledWith('wise', 'custom text')
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  it('setDailyChatAiTitlePref() forwards enabled and refreshes', async () => {
    vi.mocked(tauri.setDailyChatAiTitle).mockResolvedValue(undefined)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setDailyChatAiTitlePref(true)
    })

    expect(tauri.setDailyChatAiTitle).toHaveBeenCalledWith(true)
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  it('setResponseLanguage() forwards the language and refreshes', async () => {
    vi.mocked(tauri.setAiResponseLanguage).mockResolvedValue(undefined)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setResponseLanguage('French')
    })

    expect(tauri.setAiResponseLanguage).toHaveBeenCalledWith('French')
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  it('saveCredential() forwards presetId/endpoint/apiKey and refreshes', async () => {
    vi.mocked(tauri.setAiProviderCredential).mockResolvedValue({
      presetId: 'openai',
      endpointClass: 'remote',
      requiresPrivacyConsent: true,
    })
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let outcome: Awaited<ReturnType<typeof result.current.saveCredential>> | undefined
    await act(async () => {
      outcome = await result.current.saveCredential('openai', 'https://api.openai.com/v1', 'sk-x')
    })

    expect(tauri.setAiProviderCredential).toHaveBeenCalledWith(
      'openai',
      'https://api.openai.com/v1',
      'sk-x',
    )
    expect(outcome?.requiresPrivacyConsent).toBe(true)
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  it('testCredential() forwards args without persisting or refreshing', async () => {
    vi.mocked(tauri.testAiProviderCredential).mockResolvedValue({
      latencyMs: 42,
      dim: null,
      modelCount: null,
    })
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.testCredential(
        'custom',
        'https://example.com/v1',
        null,
        'gpt-5',
        'embed',
      )
    })

    expect(tauri.testAiProviderCredential).toHaveBeenCalledWith(
      'custom',
      'https://example.com/v1',
      null,
      'gpt-5',
      'embed',
    )
    // testCredential is a transient probe — no refresh round-trip.
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(1)
  })

  it('loads credentials on mount', async () => {
    const rows: ProviderCredential[] = [
      {
        presetId: 'openai',
        endpoint: 'https://api.openai.com/v1',
        hasApiKey: true,
        endpointClass: 'remote',
      },
      {
        presetId: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        hasApiKey: false,
        endpointClass: 'local',
      },
    ]
    vi.mocked(tauri.getAiProviderCredentials).mockResolvedValue(rows)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.credentials).toEqual(rows)
  })

  it('starts with an empty credentials array before the first read resolves', () => {
    const { result } = renderHook(() => useAIProviderConfig())
    expect(result.current.credentials).toEqual([])
  })

  // `credentialsLoaded` is what lets callers tell "no rows" apart from "not
  // read yet". Callers GATE AI features on credential presence, so if this
  // ever went true without a successful read, an unread registry would read
  // as "nothing is connected" and disable the entire AI page.
  it('reports credentialsLoaded false before the first read and true after it succeeds', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    expect(result.current.credentialsLoaded).toBe(false)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.credentialsLoaded).toBe(true)
  })

  it('leaves credentialsLoaded false when the credentials read rejects', async () => {
    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValueOnce(
      new Error('registry unreachable'),
    )
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.credentialsLoaded).toBe(false)
    // …and recovers on the next successful refresh, so the fallback is not
    // permanent.
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.credentialsLoaded).toBe(true)
  })

  it('captures error when getAiProviderCredentials rejects, alongside a successful settings/providers read', async () => {
    vi.mocked(tauri.getAiProviderCredentials).mockRejectedValueOnce(
      new Error('registry unreachable'),
    )
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('registry unreachable')
    expect(result.current.settings).toEqual(SETTINGS_UNCONFIGURED)
  })

  it('forgetCredential() forwards presetId and refreshes', async () => {
    vi.mocked(tauri.forgetAiProviderCredential).mockResolvedValue(undefined)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.forgetCredential('openai')
    })

    expect(tauri.forgetAiProviderCredential).toHaveBeenCalledWith('openai')
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  it('setEmotionLanguage() forwards the language and refreshes', async () => {
    vi.mocked(tauri.setEmotionSuggestionLanguage).mockResolvedValue(undefined)
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setEmotionLanguage('auto')
    })

    expect(tauri.setEmotionSuggestionLanguage).toHaveBeenCalledWith('auto')
    expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)
  })

  // ── Image slot (independent of the generation slot, 2026-08-07) ─────────

  it('saveImage calls set_ai_image_provider and refreshes the snapshot', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const saved: AIProvidersConfig = {
      generation: null,
      image: {
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        endpointClass: 'remote',
        imageModel: 'gpt-image-2',
        hasApiKey: true,
      },
      embedding: null,
    }
    vi.mocked(tauri.setAiImageProvider).mockResolvedValueOnce({
      provider: 'openai',
      endpointClass: 'remote',
      requiresPrivacyConsent: false,
    })
    vi.mocked(tauri.getAiProviders).mockResolvedValueOnce(saved)

    await act(async () => {
      await result.current.saveImage({ provider: 'openai', imageModel: 'gpt-image-2' })
    })

    expect(tauri.setAiImageProvider).toHaveBeenCalledWith({
      provider: 'openai',
      imageModel: 'gpt-image-2',
    })
    expect(result.current.providers).toEqual(saved)
    // Saving the image slot must never reach the generation slot.
    expect(tauri.setAiGenerationProvider).not.toHaveBeenCalled()
  })

  it('saveImage surfaces the privacy-consent hint from the backend', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    vi.mocked(tauri.setAiImageProvider).mockResolvedValueOnce({
      provider: 'openai',
      endpointClass: 'remote',
      requiresPrivacyConsent: true,
    })

    let outcome: { requiresPrivacyConsent: boolean } | undefined
    await act(async () => {
      outcome = await result.current.saveImage({ provider: 'openai', imageModel: 'gpt-image-2' })
    })
    expect(outcome?.requiresPrivacyConsent).toBe(true)
  })

  it('saveImage propagates a backend rejection instead of swallowing it', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    vi.mocked(tauri.setAiImageProvider).mockRejectedValueOnce(new Error('image model required'))
    await expect(result.current.saveImage({ provider: 'openai', imageModel: '' })).rejects.toThrow(
      'image model required',
    )
  })

  it('forgetImage clears only the image slot and refreshes', async () => {
    const { result } = renderHook(() => useAIProviderConfig())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const afterForget: AIProvidersConfig = {
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
    vi.mocked(tauri.forgetAiImageProvider).mockResolvedValueOnce(undefined)
    vi.mocked(tauri.getAiProviders).mockResolvedValueOnce(afterForget)

    await act(async () => {
      await result.current.forgetImage()
    })

    expect(tauri.forgetAiImageProvider).toHaveBeenCalledTimes(1)
    expect(tauri.forgetAiGenerationProvider).not.toHaveBeenCalled()
    expect(result.current.providers?.image).toBeNull()
    expect(result.current.providers?.generation).not.toBeNull()
  })
})
