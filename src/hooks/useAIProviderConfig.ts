import { useCallback, useEffect, useRef, useState } from 'react'
import {
  acceptAiPrivacy,
  forgetAiEmbeddingProvider,
  forgetAiGenerationProvider,
  forgetAiImageProvider,
  forgetAiProviderCredential,
  getAiProviderCredentials,
  getAiSettings,
  setAiEmbeddingProvider,
  setAiFeature,
  setAiGenerationProvider,
  setAiImageProvider,
  setAiProviderCredential,
  setAiResponseLanguage,
  setDailyChatAiTitle,
  setDailyChatPreferences,
  setEmotionSuggestionLanguage,
  testAiEmbeddingProvider,
  testAiGenerationProvider,
  testAiProviderCredential,
} from '../lib/tauri'
import { cacheAiCredentials } from '../lib/aiFeatureAccessors'
import { formatPartialFeatureUpdateError } from '../lib/onboardingAiFeatures'
import { useAiSettingsStore } from '../stores/aiSettingsStore'
import type {
  AIEmbedProviderConfigInput,
  AIFeature,
  AIFullSettings,
  AIGenProviderConfigInput,
  AIImageProviderConfigInput,
  AIProvidersConfig,
  ProviderCredential,
  SetCredentialOutcome,
  SetProviderResult,
  SlotTestResult,
  TestCredentialOutcome,
} from '../types/ai'

/**
 * Single source of truth for the AI Settings panel (Phase 6 v2 R11+).
 *
 * Wraps the two-slot IPC commands behind a stable hook surface:
 *
 * - `settings` — `AIFullSettings | null` (null while the first read is in
 *   flight; never holds the API key — only `hasApiKey`).
 * - `providers` — per-slot provider config (`null` while loading).
 * - `credentials` — every preset's per-preset credential registry row
 *   (T1.6 / T3.2), consumed by `ProvidersTab`.
 * - `loading` / `error` — first-load state.
 * - `saveGeneration(input)` / `saveEmbedding(input)` / `forgetGeneration()` /
 *   `forgetEmbedding()` — provider config mutations; all refresh the snapshot
 *   before resolving so the UI doesn't have to remember to re-read.
 * - `testGeneration(input)` / `testEmbedding(input)` — probes WITHOUT persisting.
 * - `acceptPrivacy()` / `setFeature()` — unified privacy receipt +
 *   per-feature toggles. `setFeature` rejects with
 *   `AI_PRIVACY_NOT_ACCEPTED` when enabling a non-local slot without
 *   consent.
 *
 * The hook is intentionally stateless beyond the snapshot. It does NOT
 * cache the form's draft state — the Settings panel owns that locally.
 */
export interface UseAIProviderConfigReturn {
  settings: AIFullSettings | null
  /** Per-slot provider config (R11+). `null` while the first read is
   *  in flight; each slot's nested entry is `null` when that slot is
   *  unconfigured. */
  providers: AIProvidersConfig | null
  /** Every preset's per-preset credential registry row (T1.6), one entry
   *  per `PROVIDER_PRESETS` id regardless of whether a slot currently
   *  points at it. Empty array while the first read is in flight —
   *  callers (`ProvidersTab`) treat "not yet loaded" and "no rows" the
   *  same way, since a real registry read always returns all preset ids. */
  credentials: ProviderCredential[]
  /** True once the credential registry has been read successfully at least
   *  once. `credentials` alone cannot distinguish "no rows" from "not read
   *  yet" (or "the read failed"), and callers that GATE features on
   *  credential presence must not treat an unread registry as "nothing is
   *  connected" — that would disable the whole AI page on one failed IPC. */
  credentialsLoaded: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  // ── Two-slot API (R11+) ──────────────────────────────────────────
  saveGeneration: (input: AIGenProviderConfigInput) => Promise<SetProviderResult>
  /** Persist + swap the image slot. Independent of `saveGeneration` since
   *  2026-08-07 — saving one never touches the other. */
  saveImage: (input: AIImageProviderConfigInput) => Promise<SetProviderResult>
  saveEmbedding: (input: AIEmbedProviderConfigInput) => Promise<SetProviderResult>
  forgetGeneration: () => Promise<void>
  forgetImage: () => Promise<void>
  forgetEmbedding: () => Promise<void>
  testGeneration: (input: AIGenProviderConfigInput) => Promise<SlotTestResult>
  testEmbedding: (input: AIEmbedProviderConfigInput) => Promise<SlotTestResult>
  // ── Per-preset credential registry (T1.6 / T2.6 cutover) ────────────
  /** Persist a preset's endpoint/API key through the per-preset credential
   *  registry and reconcile every bound slot, then refresh the snapshot —
   *  same posture as `saveGeneration` / `saveEmbedding`. Call this BEFORE
   *  the per-slot save so the slot's provider+model save resolves the
   *  just-written credential. */
  saveCredential: (
    presetId: string,
    endpoint: string,
    apiKey: string | null,
  ) => Promise<SetCredentialOutcome>
  /** Wipe a preset's stored endpoint override + API key and reconcile every
   *  bound slot — the per-preset analogue of `forgetGeneration` /
   *  `forgetEmbedding`. Refreshes the snapshot before resolving. */
  forgetCredential: (presetId: string) => Promise<void>
  /** Transient credential probe using the form's live (not-yet-saved)
   *  endpoint/key — never persists, never refreshes. */
  testCredential: (
    presetId: string,
    endpoint: string,
    apiKey: string | null,
    probeModel?: string,
    capability?: string,
  ) => Promise<TestCredentialOutcome>
  /** Stamp the unified privacy receipt for non-local providers. */
  acceptPrivacy: () => Promise<number>
  // ── Feature toggles + daily-chat prefs ───────────────────────────
  setFeature: (feature: AIFeature, enabled: boolean) => Promise<void>
  /** Batch write of feature toggles with a single snapshot refresh.
   *  On mid-batch failure, still refreshes so UI matches disk, then
   *  rejects with a `PARTIAL_FEATURE_UPDATE:applied/total:cause` message
   *  (see `formatPartialFeatureUpdateError`) when any write already
   *  succeeded. */
  setFeatures: (updates: ReadonlyArray<{ feature: AIFeature; enabled: boolean }>) => Promise<void>
  /** Persona + custom persona only — Daily Chat's reply language now
   *  comes from the global `setResponseLanguage` setting. */
  setDailyChatPrefs: (persona: string, customPersona: string) => Promise<void>
  setDailyChatAiTitlePref: (enabled: boolean) => Promise<void>
  setEmotionLanguage: (language: string) => Promise<void>
  /** Persist the global AI response language applied to every
   *  generation feature (see `setAiResponseLanguage`). */
  setResponseLanguage: (language: string) => Promise<void>
}

export function useAIProviderConfig(): UseAIProviderConfigReturn {
  const [settings, setSettings] = useState<AIFullSettings | null>(null)
  const [credentials, setCredentials] = useState<ProviderCredential[]>([])
  const [credentialsLoaded, setCredentialsLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const providerSnapshot = useAiSettingsStore((s) => s.providers)
  const providersHydrated = useAiSettingsStore((s) => s.providersHydrated)
  const providers = providersHydrated ? providerSnapshot : null

  // Track mount lifetime so a `refresh()` that resolves AFTER unmount
  // (or after a more recent `refresh()` superseded it) doesn't call
  // `setSettings` on a dead component or overwrite newer state. The
  // sequence id is bumped per call; only the most recent invocation
  // is allowed to mutate state.
  const aliveRef = useRef(true)
  const seqRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const mySeq = ++seqRef.current
    setLoading(true)
    try {
      // Three reads in parallel — feature toggles + daily-chat prefs come
      // from `getAiSettings`; per-slot provider config comes from the
      // shared store's sequenced `refreshProviders` path; the per-preset
      // credential registry rows (T1.6) come from `getAiProviderCredentials`.
      // All three refresh after every save so the UI reflects truth on disk.
      const [settingsResult, providersResult, credentialsResult] = await Promise.allSettled([
        Promise.resolve().then(getAiSettings),
        Promise.resolve().then(() => useAiSettingsStore.getState().refreshProviders()),
        Promise.resolve().then(getAiProviderCredentials),
      ])
      if (!aliveRef.current || mySeq !== seqRef.current) return

      // Write-through to the global AI settings store so other
      // components (EditorPanel's gated AI cards) see the fresh truth
      // without keeping their own copy in sync. Always mirror —
      // `useAIProviderConfig`'s local `settings` is the panel's draft
      // baseline; the store is the single source of truth for gated UI.
      const errors: string[] = []
      if (settingsResult.status === 'fulfilled') {
        if (settingsResult.value != null) {
          useAiSettingsStore.getState().applySnapshot(settingsResult.value)
          setSettings(settingsResult.value)
        }
      } else {
        errors.push(
          settingsResult.reason instanceof Error
            ? settingsResult.reason.message
            : String(settingsResult.reason),
        )
      }
      if (providersResult.status === 'rejected') {
        errors.push(
          providersResult.reason instanceof Error
            ? providersResult.reason.message
            : String(providersResult.reason),
        )
      }
      if (credentialsResult.status === 'fulfilled') {
        setCredentials(credentialsResult.value)
        setCredentialsLoaded(true)
        cacheAiCredentials(credentialsResult.value)
      } else {
        errors.push(
          credentialsResult.reason instanceof Error
            ? credentialsResult.reason.message
            : String(credentialsResult.reason),
        )
      }
      setError(errors.length > 0 ? errors.join('; ') : null)
    } catch (e) {
      if (!aliveRef.current || mySeq !== seqRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current && mySeq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ── Two-slot API (R11+) ────────────────────────────────────────────────

  const saveGeneration = useCallback(
    async (input: AIGenProviderConfigInput) => {
      const result = await setAiGenerationProvider(input)
      await refresh()
      return result
    },
    [refresh],
  )

  const saveImage = useCallback(
    async (input: AIImageProviderConfigInput) => {
      const result = await setAiImageProvider(input)
      await refresh()
      return result
    },
    [refresh],
  )

  const saveEmbedding = useCallback(
    async (input: AIEmbedProviderConfigInput) => {
      const result = await setAiEmbeddingProvider(input)
      await refresh()
      return result
    },
    [refresh],
  )

  const forgetGeneration = useCallback(async () => {
    await forgetAiGenerationProvider()
    await refresh()
  }, [refresh])

  const forgetImage = useCallback(async () => {
    await forgetAiImageProvider()
    await refresh()
  }, [refresh])

  const forgetEmbedding = useCallback(async () => {
    await forgetAiEmbeddingProvider()
    await refresh()
  }, [refresh])

  const testGeneration = useCallback(
    (input: AIGenProviderConfigInput) => testAiGenerationProvider(input),
    [],
  )
  const testEmbedding = useCallback(
    (input: AIEmbedProviderConfigInput) => testAiEmbeddingProvider(input),
    [],
  )

  const saveCredential = useCallback(
    async (presetId: string, endpoint: string, apiKey: string | null) => {
      const result = await setAiProviderCredential(presetId, endpoint, apiKey)
      await refresh()
      return result
    },
    [refresh],
  )

  const forgetCredential = useCallback(
    async (presetId: string) => {
      await forgetAiProviderCredential(presetId)
      await refresh()
    },
    [refresh],
  )

  const testCredential = useCallback(
    (
      presetId: string,
      endpoint: string,
      apiKey: string | null,
      probeModel?: string,
      capability?: string,
    ) => testAiProviderCredential(presetId, endpoint, apiKey, probeModel, capability),
    [],
  )

  const acceptPrivacy = useCallback(async () => {
    const ts = await acceptAiPrivacy()
    await refresh()
    return ts
  }, [refresh])

  const setFeature = useCallback(
    async (feature: AIFeature, enabled: boolean) => {
      await setAiFeature(feature, enabled)
      // Mirror into the global AI settings store so other components
      // (EditorPanel's gated AI cards) re-render live without waiting
      // for a remount. The store ignores un-tracked features.
      useAiSettingsStore.getState().setFlag(feature, enabled)
      await refresh()
    },
    [refresh],
  )

  const setFeatures = useCallback(
    async (updates: ReadonlyArray<{ feature: AIFeature; enabled: boolean }>) => {
      if (updates.length === 0) return
      let applied = 0
      try {
        for (const { feature, enabled } of updates) {
          await setAiFeature(feature, enabled)
          useAiSettingsStore.getState().setFlag(feature, enabled)
          applied += 1
        }
      } catch (e) {
        // Partial writes already hit disk — re-hydrate so toggles don't
        // lie about what's actually on. Then surface how far we got.
        await refresh()
        const cause = e instanceof Error ? e.message : String(e)
        if (applied > 0) {
          throw new Error(formatPartialFeatureUpdateError(applied, updates.length, cause))
        }
        throw e instanceof Error ? e : new Error(cause)
      }
      await refresh()
    },
    [refresh],
  )

  const setDailyChatPrefs = useCallback(
    async (persona: string, customPersona: string) => {
      await setDailyChatPreferences(persona, customPersona)
      await refresh()
    },
    [refresh],
  )

  const setDailyChatAiTitlePref = useCallback(
    async (enabled: boolean) => {
      await setDailyChatAiTitle(enabled)
      await refresh()
    },
    [refresh],
  )

  const setEmotionLanguage = useCallback(
    async (language: string) => {
      await setEmotionSuggestionLanguage(language)
      await refresh()
    },
    [refresh],
  )

  const setResponseLanguage = useCallback(
    async (language: string) => {
      await setAiResponseLanguage(language)
      await refresh()
    },
    [refresh],
  )

  return {
    settings,
    providers,
    credentials,
    credentialsLoaded,
    loading,
    error,
    refresh,
    saveGeneration,
    saveImage,
    saveEmbedding,
    forgetGeneration,
    forgetImage,
    forgetEmbedding,
    testGeneration,
    testEmbedding,
    saveCredential,
    forgetCredential,
    testCredential,
    acceptPrivacy,
    setFeature,
    setFeatures,
    setDailyChatPrefs,
    setDailyChatAiTitlePref,
    setEmotionLanguage,
    setResponseLanguage,
  }
}
