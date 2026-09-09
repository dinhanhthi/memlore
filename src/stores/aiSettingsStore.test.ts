import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({
  getAiSettings: vi.fn(),
  getAiProviders: vi.fn(),
  setMemoryGenProvider: vi.fn(),
  setMemoryEmbedProvider: vi.fn(),
  setAiProviderCredential: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import type { AIFullSettings, AIProvidersConfig } from '../types/ai'

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
    embeddingModel: 'voyage-3.5',
    hasApiKey: true,
  },
}

const OLD_PROVIDERS: AIProvidersConfig = {
  generation: {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    endpointClass: 'local',
    chatModel: 'old-model',
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
  useAiSettingsStore.setState({
    hydrated: false,
    entryHighlightsEnabled: false,
    goDeeperEnabled: false,
    dailyChatEnabled: false,
    chatMemoryEnabled: false,
    chatRagEnabled: false,
    inflightHydrate: null,
    settingsRequestSeq: 0,
    providersHydrated: false,
    providers: { generation: null, image: null, embedding: null },
    inflightProvidersHydrate: null,
    providerRequestSeq: 0,
  })
  vi.mocked(tauri.getAiSettings).mockReset()
  vi.mocked(tauri.getAiProviders).mockReset()
})

describe('aiSettingsStore', () => {
  describe('initial state', () => {
    it('starts un-hydrated with all flags off', () => {
      const s = useAiSettingsStore.getState()
      expect(s.hydrated).toBe(false)
      expect(s.entryHighlightsEnabled).toBe(false)
      expect(s.goDeeperEnabled).toBe(false)
      expect(s.dailyChatEnabled).toBe(false)
    })

    it('starts with both provider slots unconfigured and un-hydrated', () => {
      const s = useAiSettingsStore.getInitialState()
      expect(s.providersHydrated).toBe(false)
      expect(s.providers).toEqual({ generation: null, image: null, embedding: null })
    })
  })

  describe('hydrate', () => {
    it('reads getAiSettings and copies the gated flags into the store', async () => {
      vi.mocked(tauri.getAiSettings).mockResolvedValueOnce({
        ...FULL,
        entryHighlightsEnabled: true,
        goDeeperEnabled: true,
      })
      await useAiSettingsStore.getState().hydrate()
      const s = useAiSettingsStore.getState()
      expect(s.hydrated).toBe(true)
      expect(s.entryHighlightsEnabled).toBe(true)
      expect(s.goDeeperEnabled).toBe(true)
    })

    it('sets hydrated=true even when both flags are false (so consumers stop probing)', async () => {
      vi.mocked(tauri.getAiSettings).mockResolvedValueOnce(FULL)
      await useAiSettingsStore.getState().hydrate()
      expect(useAiSettingsStore.getState().hydrated).toBe(true)
    })

    it('keeps hydrated=false when getAiSettings rejects (so a future hydrate can retry)', async () => {
      vi.mocked(tauri.getAiSettings).mockRejectedValueOnce(new Error('boom'))
      await useAiSettingsStore.getState().hydrate()
      expect(useAiSettingsStore.getState().hydrated).toBe(false)
    })

    it('only fires the IPC once even when called concurrently', async () => {
      vi.mocked(tauri.getAiSettings).mockResolvedValue(FULL)
      await Promise.all([
        useAiSettingsStore.getState().hydrate(),
        useAiSettingsStore.getState().hydrate(),
        useAiSettingsStore.getState().hydrate(),
      ])
      expect(tauri.getAiSettings).toHaveBeenCalledTimes(1)
    })

    it('reset supersedes an old settings hydrate without clearing the new inflight request', async () => {
      const oldSettings = deferred<AIFullSettings>()
      const newSettings = deferred<AIFullSettings>()
      vi.mocked(tauri.getAiSettings)
        .mockReturnValueOnce(oldSettings.promise)
        .mockReturnValueOnce(newSettings.promise)

      const oldHydrate = useAiSettingsStore.getState().hydrate()
      resetAiSettingsStore()
      const newHydrate = useAiSettingsStore.getState().hydrate()
      expect(useAiSettingsStore.getState().inflightHydrate).toBe(newHydrate)

      oldSettings.resolve({ ...FULL, entryHighlightsEnabled: true })
      await oldHydrate

      expect(useAiSettingsStore.getState().hydrated).toBe(false)
      expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(false)
      expect(useAiSettingsStore.getState().inflightHydrate).toBe(newHydrate)
      expect(useAiSettingsStore.getState().hydrate()).toBe(newHydrate)
      expect(tauri.getAiSettings).toHaveBeenCalledTimes(2)

      newSettings.resolve({ ...FULL, goDeeperEnabled: true })
      await newHydrate

      expect(useAiSettingsStore.getState().hydrated).toBe(true)
      expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(false)
      expect(useAiSettingsStore.getState().goDeeperEnabled).toBe(true)
      expect(useAiSettingsStore.getState().inflightHydrate).toBeNull()
    })
  })

  describe('applySnapshot', () => {
    it('writes the gated flags from a fresh AIFullSettings into the store and marks hydrated', () => {
      useAiSettingsStore.getState().applySnapshot({
        ...FULL,
        entryHighlightsEnabled: true,
        goDeeperEnabled: true,
      })
      const s = useAiSettingsStore.getState()
      expect(s.hydrated).toBe(true)
      expect(s.entryHighlightsEnabled).toBe(true)
      expect(s.goDeeperEnabled).toBe(true)
    })

    it('overwrites previous values (true → false) so the panel refresh path drives store truth', () => {
      useAiSettingsStore.setState({ hydrated: true, entryHighlightsEnabled: true })
      useAiSettingsStore
        .getState()
        .applySnapshot({ ...FULL, entryHighlightsEnabled: false, goDeeperEnabled: false })
      expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(false)
    })

    it('copies dailyChatEnabled from the snapshot so the Sidebar gate reflects Daily Chat', () => {
      useAiSettingsStore.getState().applySnapshot({ ...FULL, dailyChatEnabled: true })
      expect(useAiSettingsStore.getState().dailyChatEnabled).toBe(true)

      useAiSettingsStore.getState().applySnapshot({ ...FULL, dailyChatEnabled: false })
      expect(useAiSettingsStore.getState().dailyChatEnabled).toBe(false)
    })

    it('leaves store state untouched when the snapshot is null', () => {
      useAiSettingsStore.setState({
        hydrated: true,
        entryHighlightsEnabled: true,
        goDeeperEnabled: true,
        privacyAcceptedAt: 1_700_000_000,
      })
      useAiSettingsStore.getState().applySnapshot(null)
      const s = useAiSettingsStore.getState()
      expect(s.hydrated).toBe(true)
      expect(s.entryHighlightsEnabled).toBe(true)
      expect(s.goDeeperEnabled).toBe(true)
      expect(s.privacyAcceptedAt).toBe(1_700_000_000)
    })
  })

  describe('provider snapshot', () => {
    it('hydrates both provider slots and shares one IPC across concurrent callers', async () => {
      vi.mocked(tauri.getAiProviders).mockResolvedValue(PROVIDERS)

      await Promise.all([
        useAiSettingsStore.getState().hydrateProviders(),
        useAiSettingsStore.getState().hydrateProviders(),
        useAiSettingsStore.getState().hydrateProviders(),
      ])

      const s = useAiSettingsStore.getState()
      expect(tauri.getAiProviders).toHaveBeenCalledTimes(1)
      expect(s.providersHydrated).toBe(true)
      expect(s.providers).toEqual(PROVIDERS)
    })

    it('refreshes generation and embedding slots in the shared snapshot', async () => {
      vi.mocked(tauri.getAiProviders).mockResolvedValueOnce(PROVIDERS)
      await useAiSettingsStore.getState().refreshProviders()

      const s = useAiSettingsStore.getState()
      expect(s.providersHydrated).toBe(true)
      expect(s.providers).toEqual(PROVIDERS)
    })

    it('stays un-hydrated after failure and retries successfully', async () => {
      vi.mocked(tauri.getAiProviders)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(PROVIDERS)

      await useAiSettingsStore.getState().hydrateProviders()
      expect(useAiSettingsStore.getState().providersHydrated).toBe(false)

      await useAiSettingsStore.getState().hydrateProviders()
      expect(tauri.getAiProviders).toHaveBeenCalledTimes(2)
      expect(useAiSettingsStore.getState().providersHydrated).toBe(true)
      expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
    })

    it('does not let an older footer hydrate overwrite a newer shared refresh', async () => {
      const oldRequest = deferred<AIProvidersConfig>()
      vi.mocked(tauri.getAiProviders)
        .mockReturnValueOnce(oldRequest.promise)
        .mockResolvedValueOnce(PROVIDERS)

      const footerHydrate = useAiSettingsStore.getState().hydrateProviders()
      await useAiSettingsStore.getState().refreshProviders()
      expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)

      oldRequest.resolve(OLD_PROVIDERS)
      await footerHydrate

      expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
    })

    it('invalidates a hydrated snapshot after the latest refresh fails and retries cleanly', async () => {
      vi.mocked(tauri.getAiProviders)
        .mockResolvedValueOnce(OLD_PROVIDERS)
        .mockRejectedValueOnce(new Error('provider refresh failed'))
        .mockResolvedValueOnce(PROVIDERS)

      await useAiSettingsStore.getState().refreshProviders()
      expect(useAiSettingsStore.getState().providers).toEqual(OLD_PROVIDERS)

      await expect(useAiSettingsStore.getState().refreshProviders()).rejects.toThrow(
        'provider refresh failed',
      )
      expect(useAiSettingsStore.getState().providersHydrated).toBe(false)
      expect(useAiSettingsStore.getState().providers).toEqual({
        generation: null,
        image: null,
        embedding: null,
      })

      await useAiSettingsStore.getState().hydrateProviders()
      expect(useAiSettingsStore.getState().providersHydrated).toBe(true)
      expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
    })

    it('does not let an older failed refresh invalidate a newer successful snapshot', async () => {
      const oldRequest = deferred<AIProvidersConfig>()
      vi.mocked(tauri.getAiProviders)
        .mockReturnValueOnce(oldRequest.promise)
        .mockResolvedValueOnce(PROVIDERS)

      const oldResult = useAiSettingsStore
        .getState()
        .refreshProviders()
        .catch((error: unknown) => error)
      await useAiSettingsStore.getState().refreshProviders()

      oldRequest.reject(new Error('stale failure'))
      await expect(oldResult).resolves.toEqual(PROVIDERS)
      expect(useAiSettingsStore.getState().providersHydrated).toBe(true)
      expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
    })

    it('reset keeps an old provider hydrate from clearing or replacing the new inflight request', async () => {
      const oldProviders = deferred<AIProvidersConfig>()
      const newProviders = deferred<AIProvidersConfig>()
      vi.mocked(tauri.getAiProviders)
        .mockReturnValueOnce(oldProviders.promise)
        .mockReturnValueOnce(newProviders.promise)

      const oldHydrate = useAiSettingsStore.getState().hydrateProviders()
      resetAiSettingsStore()
      const newHydrate = useAiSettingsStore.getState().hydrateProviders()
      expect(useAiSettingsStore.getState().inflightProvidersHydrate).toBe(newHydrate)

      oldProviders.resolve(OLD_PROVIDERS)
      await oldHydrate

      expect(useAiSettingsStore.getState().providersHydrated).toBe(false)
      expect(useAiSettingsStore.getState().providers).toEqual({
        generation: null,
        image: null,
        embedding: null,
      })
      expect(useAiSettingsStore.getState().inflightProvidersHydrate).toBe(newHydrate)
      expect(useAiSettingsStore.getState().hydrateProviders()).toBe(newHydrate)
      expect(tauri.getAiProviders).toHaveBeenCalledTimes(2)

      newProviders.resolve(PROVIDERS)
      await newHydrate

      expect(useAiSettingsStore.getState().providersHydrated).toBe(true)
      expect(useAiSettingsStore.getState().providers).toEqual(PROVIDERS)
      expect(useAiSettingsStore.getState().inflightProvidersHydrate).toBeNull()
    })
  })

  describe('saveCredential', () => {
    it('forwards presetId/endpoint/apiKey to setAiProviderCredential', async () => {
      vi.mocked(tauri.setAiProviderCredential).mockResolvedValueOnce({
        presetId: 'ollama',
        endpointClass: 'local',
        requiresPrivacyConsent: false,
      })

      const outcome = await useAiSettingsStore
        .getState()
        .saveCredential('ollama', 'http://127.0.0.1:11434/v1', null)

      expect(tauri.setAiProviderCredential).toHaveBeenCalledWith(
        'ollama',
        'http://127.0.0.1:11434/v1',
        null,
      )
      expect(outcome).toEqual({
        presetId: 'ollama',
        endpointClass: 'local',
        requiresPrivacyConsent: false,
      })
    })
  })

  describe('setFlag', () => {
    it('flips entry_highlights flag in the store', () => {
      useAiSettingsStore.getState().setFlag('entry_highlights', true)
      expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(true)
      useAiSettingsStore.getState().setFlag('entry_highlights', false)
      expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(false)
    })

    it('flips go_deeper flag in the store', () => {
      useAiSettingsStore.getState().setFlag('go_deeper', true)
      expect(useAiSettingsStore.getState().goDeeperEnabled).toBe(true)
    })

    it('flips the persona flag independently of the user_memory feature flag', () => {
      // Persona is a `user_persona` column, not a settings key, so it gets its
      // own setter — and the two must not shadow each other.
      useAiSettingsStore.getState().setFlag('user_memory', false)
      useAiSettingsStore.getState().setPersonaEnabled(true)
      expect(useAiSettingsStore.getState().personaEnabled).toBe(true)
      expect(useAiSettingsStore.getState().userMemoryEnabled).toBe(false)

      useAiSettingsStore.getState().setPersonaEnabled(false)
      expect(useAiSettingsStore.getState().personaEnabled).toBe(false)
    })

    it('flips chat_memory flag in the store without touching daily_chat', () => {
      // `setFlag` is an else-if chain — a dropped or misspelled arm fails
      // silently, so pin this one the way every sibling flag is pinned.
      useAiSettingsStore.getState().setFlag('daily_chat', true)
      useAiSettingsStore.getState().setFlag('chat_memory', true)
      expect(useAiSettingsStore.getState().chatMemoryEnabled).toBe(true)

      useAiSettingsStore.getState().setFlag('chat_memory', false)
      expect(useAiSettingsStore.getState().chatMemoryEnabled).toBe(false)
      expect(useAiSettingsStore.getState().dailyChatEnabled).toBe(true)
    })

    it('flips continue_writing flag in the store', () => {
      useAiSettingsStore.getState().setFlag('continue_writing', true)
      expect(useAiSettingsStore.getState().continueWritingEnabled).toBe(true)
      useAiSettingsStore.getState().setFlag('continue_writing', false)
      expect(useAiSettingsStore.getState().continueWritingEnabled).toBe(false)
    })

    it('does not let continue_writing bleed into the go_deeper flag', () => {
      useAiSettingsStore.getState().setFlag('go_deeper', true)
      useAiSettingsStore.getState().setFlag('continue_writing', false)
      expect(useAiSettingsStore.getState().goDeeperEnabled).toBe(true)
    })

    it('flips tag_suggestions flag in the store', () => {
      useAiSettingsStore.getState().setFlag('tag_suggestions', true)
      expect(useAiSettingsStore.getState().tagSuggestionsEnabled).toBe(true)
    })

    it('flips daily_chat flag in the store', () => {
      useAiSettingsStore.getState().setFlag('daily_chat', true)
      expect(useAiSettingsStore.getState().dailyChatEnabled).toBe(true)
      useAiSettingsStore.getState().setFlag('daily_chat', false)
      expect(useAiSettingsStore.getState().dailyChatEnabled).toBe(false)
    })

    it('flips chat_rag flag in the store', () => {
      useAiSettingsStore.getState().setFlag('chat_rag', true)
      expect(useAiSettingsStore.getState().chatRagEnabled).toBe(true)
      useAiSettingsStore.getState().setFlag('chat_rag', false)
      expect(useAiSettingsStore.getState().chatRagEnabled).toBe(false)
    })

    it('flips user_memory flag in the store', () => {
      useAiSettingsStore.getState().setFlag('user_memory', true)
      expect(useAiSettingsStore.getState().userMemoryEnabled).toBe(true)
      useAiSettingsStore.getState().setFlag('user_memory', false)
      expect(useAiSettingsStore.getState().userMemoryEnabled).toBe(false)
    })

    it('ignores unknown features instead of throwing (forward-compat with new flags)', () => {
      // Casting only here — runtime input may legitimately be an unknown
      // feature key when other un-tracked flags flip; we don't want them
      // to crash the panel.
      useAiSettingsStore
        .getState()
        .setFlag('semantic_search' as unknown as 'entry_highlights', true)
      expect(useAiSettingsStore.getState().entryHighlightsEnabled).toBe(false)
      expect(useAiSettingsStore.getState().goDeeperEnabled).toBe(false)
    })
  })
})
