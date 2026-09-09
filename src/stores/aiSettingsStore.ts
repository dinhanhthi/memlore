import { create } from 'zustand'
import {
  getAiProviders,
  getAiSettings,
  setAiProviderCredential,
  setMemoryEmbedProvider,
  setMemoryGenProvider,
} from '../lib/tauri'
import type {
  AIFeature,
  AIFullSettings,
  AIMemoryEmbedProviderConfig,
  AIMemoryEmbedProviderConfigInput,
  AIMemoryGenProviderConfig,
  AIMemoryGenProviderConfigInput,
  AIProvidersConfig,
  SetCredentialOutcome,
  SetProviderResult,
} from '../types/ai'

interface AiSettingsState {
  /** True once a snapshot has been written into the store at least once.
   *  While false, gated UI should render the loading/null state instead
   *  of `false` — the flag may still be on, we just haven't read it yet. */
  hydrated: boolean
  semanticSearchEnabled: boolean
  emotionSuggestionsEnabled: boolean
  titleSuggestionsEnabled: boolean
  entryHighlightsEnabled: boolean
  goDeeperEnabled: boolean
  /** Editor footer "Continue writing with your voice". Tracked so the
   *  footer button appears/disappears live when Settings toggles it. */
  continueWritingEnabled: boolean
  multiEntrySummaryEnabled: boolean
  periodicReviewEnabled: boolean
  tagSuggestionsEnabled: boolean
  insightsEnabled: boolean
  /** Dashboard insights card. Fail-closed default `false`. UI-only gate;
   *  generation stays behind `theme_insights` / `INSIGHTS_ENABLED`. */
  dashboardInsightsEnabled: boolean
  /** Daily Chat sidebar nav gate (Phase 6 v2 R9). Tracked so the Sidebar
   *  re-renders live when Settings toggles the feature. */
  dailyChatEnabled: boolean
  /** "Use my memories in Daily Chat". Fail-closed default `false`. */
  chatMemoryEnabled: boolean
  /** Auto-RAG in Daily Chat. Fail-closed default `false` — tracked so the
   *  chat toggle and settings row stay in sync, same pattern as the other
   *  gated flags. */
  chatRagEnabled: boolean
  imageGenerationEnabled: boolean
  /** Master preference for AI User Memory. Hydrated from
   *  `AIFullSettings.userMemoryEnabled` (`ai_user_memory_enabled`, default ON).
   *  When false, Settings → Memories disables its controls and the backend
   *  skips scan/extract/chat memory RAG. Slot readiness is separate —
   *  see `memoryGen` / `memoryEmbed`. */
  userMemoryEnabled: boolean
  /** "Use persona" (`user_persona.enabled`). Tracked here so persona-gated UI
   *  — the editor's Continue & Rewrite affordances and the Features row —
   *  re-render the moment Settings flips it. Independent of
   *  `userMemoryEnabled`. */
  personaEnabled: boolean
  /** "AI-generated titles" for Daily Chat sessions. Tracked here so the
   *  command palette can read it imperatively. */
  dailyChatAiTitle: boolean
  /** Memory generation slot config (null when unconfigured). Assembled from
   *  the flat `memoryGen*` fields on `AIFullSettings` — memory generation has
   *  no image model, so this is a subset of the app-wide generation slot. */
  memoryGen: AIMemoryGenProviderConfig | null
  /** Memory embedding slot config (null when unconfigured). Assembled from
   *  the flat `memoryEmbed*` fields on `AIFullSettings`. */
  memoryEmbed: AIMemoryEmbedProviderConfig | null
  /** Unified AI privacy receipt timestamp (null = not accepted). Stored here
   *  so imperative feature-actionability checks can read it without IPC. */
  privacyAcceptedAt: number | null
  providersHydrated: boolean
  providers: AIProvidersConfig
  /** Shared in-flight `hydrate()` promise. Lives inside the store (not as
   *  a module-level mutable) so `setState` resets it atomically alongside
   *  the data fields — keeps tests isolated and avoids leaking state
   *  between renders. */
  inflightHydrate: Promise<void> | null
  inflightProvidersHydrate: Promise<void> | null
  settingsRequestSeq: number
  providerRequestSeq: number

  /** One-shot read from Tauri → store. Concurrent calls share a single
   *  in-flight IPC so a settings panel + editor mounting in the same
   *  tick don't fire two probes. */
  hydrate: () => Promise<void>
  /** Read the sanitized two-slot provider snapshot once. Concurrent
   *  consumers share one IPC request. */
  hydrateProviders: () => Promise<void>
  /** Fetch the provider snapshot and apply it only when no newer shared
   *  provider request has started. Returns the current shared value so a
   *  superseded request cannot leak its stale result to callers. */
  refreshProviders: () => Promise<AIProvidersConfig>
  /** Write-through entry point: copy the gated flags from a fresh
   *  `AIFullSettings` snapshot into the store. `null` is a no-op (leave
   *  current state untouched) — the web harness can resolve
   *  `getAiSettings()` to null. The Settings panel's
   *  `useAIProviderConfig` calls this every time `getAiSettings()`
   *  resolves so the store stays the single source of truth across
   *  every consumer (`EditorPanel` and other gated UI). */
  applySnapshot: (s: AIFullSettings | null) => void
  /** Reflect a flag mutation that already succeeded in the backend.
   *  Settings panel calls this immediately after `setAiFeature`
   *  resolves so subscribed components re-render before the next
   *  refresh round-trip finishes. Unknown `feature` keys are ignored
   *  (forward-compat with un-tracked flags). */
  setFlag: (feature: AIFeature, enabled: boolean) => void
  /** Same contract as `setFlag`, for the persona flag. Persona lives in the
   *  `user_persona` row rather than the settings table, so it is not an
   *  `AIFeature` and needs its own setter. Call it right after the
   *  `set_persona_enabled` IPC resolves. */
  setPersonaEnabled: (enabled: boolean) => void
  /** Persist + swap the memory generation provider (writes the
   *  `ai_memory_gen_*` rows). Thin wrapper over the T5.1 IPC — the
   *  Settings panel re-hydrates via `hydrate()` after this resolves so
   *  `userMemoryEnabled` / `memoryGen` reflect the new state. */
  saveMemoryGenProvider: (input: AIMemoryGenProviderConfigInput) => Promise<SetProviderResult>
  /** Persist + swap the memory embedding provider (writes the
   *  `ai_memory_embed_*` rows). Same thin-wrapper pattern. */
  saveMemoryEmbedProvider: (input: AIMemoryEmbedProviderConfigInput) => Promise<SetProviderResult>
  /** Persist a preset's endpoint/API key through the per-preset credential
   *  registry (T1.6) and reconcile bound slots. Thin wrapper — typically
   *  called from the Providers tab before a feature slot saves
   *  provider+model. */
  saveCredential: (
    presetId: string,
    endpoint: string,
    apiKey: string | null,
  ) => Promise<SetCredentialOutcome>
}

export const useAiSettingsStore = create<AiSettingsState>()((set, get) => ({
  hydrated: false,
  semanticSearchEnabled: false,
  emotionSuggestionsEnabled: false,
  titleSuggestionsEnabled: false,
  entryHighlightsEnabled: false,
  goDeeperEnabled: false,
  continueWritingEnabled: false,
  multiEntrySummaryEnabled: false,
  periodicReviewEnabled: false,
  tagSuggestionsEnabled: false,
  insightsEnabled: false,
  dashboardInsightsEnabled: false,
  dailyChatEnabled: false,
  chatMemoryEnabled: false,
  chatRagEnabled: false,
  imageGenerationEnabled: false,
  userMemoryEnabled: false,
  personaEnabled: false,
  dailyChatAiTitle: false,
  memoryGen: null,
  memoryEmbed: null,
  privacyAcceptedAt: null,
  providersHydrated: false,
  providers: { generation: null, image: null, embedding: null },
  inflightHydrate: null,
  inflightProvidersHydrate: null,
  settingsRequestSeq: 0,
  providerRequestSeq: 0,

  hydrate: () => {
    const existing = get().inflightHydrate
    if (existing) return existing
    const requestSeq = get().settingsRequestSeq + 1
    set({ settingsRequestSeq: requestSeq })
    let hydratePromise: Promise<void> | null = null
    const p = Promise.resolve()
      .then(getAiSettings)
      .then((s) => {
        if (get().settingsRequestSeq === requestSeq) {
          get().applySnapshot(s)
        }
      })
      .catch(() => {
        // Leave hydrated=false so a future call can retry.
      })
      .finally(() => {
        if (get().inflightHydrate === hydratePromise) {
          set({ inflightHydrate: null })
        }
      })
    hydratePromise = p
    set({ inflightHydrate: p })
    return p
  },

  hydrateProviders: () => {
    const existing = get().inflightProvidersHydrate
    if (existing) return existing
    let hydratePromise: Promise<void> | null = null
    const p = get()
      .refreshProviders()
      .then(() => undefined)
      .catch(() => {
        // Leave providersHydrated=false so a future call can retry.
      })
      .finally(() => {
        if (get().inflightProvidersHydrate === hydratePromise) {
          set({ inflightProvidersHydrate: null })
        }
      })
    hydratePromise = p
    set({ inflightProvidersHydrate: p })
    return p
  },

  refreshProviders: () => {
    const requestSeq = get().providerRequestSeq + 1
    set({ providerRequestSeq: requestSeq })
    return getAiProviders()
      .then((providers) => {
        if (get().providerRequestSeq === requestSeq) {
          set({ providers, providersHydrated: true })
        }
        return get().providers
      })
      .catch((error: unknown) => {
        if (get().providerRequestSeq === requestSeq) {
          set({
            providers: { generation: null, image: null, embedding: null },
            providersHydrated: false,
          })
          throw error
        }
        return get().providers
      })
  },

  applySnapshot: (s) => {
    if (s == null) return
    set({
      hydrated: true,
      semanticSearchEnabled: s.semanticSearchEnabled,
      emotionSuggestionsEnabled: s.emotionSuggestionsEnabled,
      titleSuggestionsEnabled: s.titleSuggestionsEnabled,
      entryHighlightsEnabled: s.entryHighlightsEnabled,
      goDeeperEnabled: s.goDeeperEnabled,
      continueWritingEnabled: s.continueWritingEnabled,
      multiEntrySummaryEnabled: s.multiEntrySummaryEnabled,
      periodicReviewEnabled: s.periodicReviewEnabled,
      tagSuggestionsEnabled: s.tagSuggestionsEnabled,
      insightsEnabled: s.insightsEnabled,
      dashboardInsightsEnabled: s.dashboardInsightsEnabled,
      dailyChatEnabled: s.dailyChatEnabled,
      chatMemoryEnabled: s.chatMemoryEnabled,
      chatRagEnabled: s.chatRagEnabled,
      imageGenerationEnabled: s.imageGenerationEnabled,
      userMemoryEnabled: s.userMemoryEnabled,
      personaEnabled: s.personaEnabled,
      dailyChatAiTitle: s.dailyChatAiTitle,
      memoryGen: s.memoryGenProvider
        ? {
            provider: s.memoryGenProvider,
            endpoint: s.memoryGenEndpoint ?? '',
            endpointClass: s.memoryGenEndpointClass ?? 'local',
            chatModel: s.memoryGenChatModel ?? '',
            hasApiKey: s.memoryGenHasApiKey,
          }
        : null,
      memoryEmbed: s.memoryEmbedProvider
        ? {
            provider: s.memoryEmbedProvider,
            endpoint: s.memoryEmbedEndpoint ?? '',
            endpointClass: s.memoryEmbedEndpointClass ?? 'local',
            embeddingModel: s.memoryEmbedEmbeddingModel ?? '',
            hasApiKey: s.memoryEmbedHasApiKey,
          }
        : null,
      privacyAcceptedAt: s.privacyAcceptedAt,
    })
  },

  setFlag: (feature, enabled) => {
    if (feature === 'semantic_search') set({ semanticSearchEnabled: enabled })
    else if (feature === 'emotion_suggestions') set({ emotionSuggestionsEnabled: enabled })
    else if (feature === 'title_suggestions') set({ titleSuggestionsEnabled: enabled })
    else if (feature === 'entry_highlights') set({ entryHighlightsEnabled: enabled })
    else if (feature === 'go_deeper') set({ goDeeperEnabled: enabled })
    else if (feature === 'continue_writing') set({ continueWritingEnabled: enabled })
    else if (feature === 'multi_entry_summary') set({ multiEntrySummaryEnabled: enabled })
    else if (feature === 'periodic_review') set({ periodicReviewEnabled: enabled })
    else if (feature === 'tag_suggestions') set({ tagSuggestionsEnabled: enabled })
    else if (feature === 'theme_insights') set({ insightsEnabled: enabled })
    else if (feature === 'dashboard_insights') set({ dashboardInsightsEnabled: enabled })
    else if (feature === 'daily_chat') set({ dailyChatEnabled: enabled })
    else if (feature === 'chat_memory') set({ chatMemoryEnabled: enabled })
    else if (feature === 'chat_rag') set({ chatRagEnabled: enabled })
    else if (feature === 'image_generation') set({ imageGenerationEnabled: enabled })
    else if (feature === 'user_memory') set({ userMemoryEnabled: enabled })
    // Other features are not (yet) tracked here — ignore.
  },

  setPersonaEnabled: (enabled) => set({ personaEnabled: enabled }),

  saveMemoryGenProvider: (input) => setMemoryGenProvider(input),

  saveMemoryEmbedProvider: (input) => setMemoryEmbedProvider(input),

  saveCredential: (presetId, endpoint, apiKey) =>
    setAiProviderCredential(presetId, endpoint, apiKey),
}))

/** Restore the complete initial store shape for same-page web scenario
 * switches while advancing both tokens past every in-flight request. */
export function resetAiSettingsStore(): void {
  const current = useAiSettingsStore.getState()
  const settingsRequestSeq = current.settingsRequestSeq + 1
  const providerRequestSeq = current.providerRequestSeq + 1
  useAiSettingsStore.setState(
    {
      ...useAiSettingsStore.getInitialState(),
      settingsRequestSeq,
      providerRequestSeq,
    },
    true,
  )
}
