/**
 * Imperative AI-feature accessors for the command palette.
 *
 * These functions read/write AI feature state without React hooks, using the
 * same stores and IPC calls the Settings panel uses. The actionability gate
 * mirrors `AISettingsPanel.genFeatureState` — provider slot configured +
 * privacy accepted — so the palette only shows a toggle command when the
 * user can actually flip it.
 */
import { isPrivacyExemptClass, slotIsConnected } from './aiProviderStatus'
import {
  setAiFeature,
  setDailyChatAiTitle as persistDailyChatAiTitle,
  setPersonaEnabled as persistPersonaEnabled,
} from './tauri'
import { useAiSettingsStore } from '../stores/aiSettingsStore'
import { useUiStore } from '../stores/uiStore'
import type { AIFeature, EndpointClass, ProviderCredential } from '../types/ai'

// ── Feature flag read ─────────────────────────────────────────────────

/** Non-reactive read of whether an AI feature is currently enabled. */
export function getAiFeatureEnabled(feature: AIFeature): boolean {
  const s = useAiSettingsStore.getState()
  switch (feature) {
    case 'semantic_search':
      return s.semanticSearchEnabled
    case 'emotion_suggestions':
      return s.emotionSuggestionsEnabled
    case 'title_suggestions':
      return s.titleSuggestionsEnabled
    case 'entry_highlights':
      return s.entryHighlightsEnabled
    case 'go_deeper':
      return s.goDeeperEnabled
    case 'continue_writing':
      return s.continueWritingEnabled
    case 'multi_entry_summary':
      return s.multiEntrySummaryEnabled
    case 'periodic_review':
      return s.periodicReviewEnabled
    case 'tag_suggestions':
      return s.tagSuggestionsEnabled
    case 'theme_insights':
      return s.insightsEnabled
    case 'dashboard_insights':
      return s.dashboardInsightsEnabled
    case 'daily_chat':
      return s.dailyChatEnabled
    case 'chat_memory':
      return s.chatMemoryEnabled
    case 'chat_rag':
      return s.chatRagEnabled
    case 'image_generation':
      return s.imageGenerationEnabled
    case 'user_memory':
      return s.userMemoryEnabled
  }
}

// ── Feature flag write ────────────────────────────────────────────────

/**
 * Imperative feature toggle — mirrors `AISettingsPanel.handleSetFeature`.
 * Persists via the backend IPC, then patches the store so subscribers
 * re-render immediately.
 */
export async function setAiFeatureImperative(feature: AIFeature, enabled: boolean): Promise<void> {
  await setAiFeature(feature, enabled)
  useAiSettingsStore.getState().setFlag(feature, enabled)
}

// ── Actionability gate ────────────────────────────────────────────────

/** True when the privacy gate is clear for a given endpoint class. */
function privacyCleared(endpointClass: EndpointClass, privacyAcceptedAt: number | null): boolean {
  return isPrivacyExemptClass(endpointClass) || privacyAcceptedAt != null
}

// ── Credential cache for imperative slot-connected checks ─────────────
// Mirrors the credential-registry check the Settings panel performs via
// `slotIsConnected`. Populated by `useAIProviderConfig` each time it
// refreshes credentials; before that first load the gate falls back to
// the permissive `config != null` check (same as the UI — see
// `AISettingsPanel.tsx` `slotConnected` callback).

type OnDeviceKind = 'embed' | 'llm'

let cachedCredentials: ProviderCredential[] = []
let credentialsCached = false

/** Per-kind "a downloaded model exists on this device". Fed by
 *  `useOnDeviceModels` / `useOnDeviceLlmModels` `refresh()` so any mounted
 *  instance updates the palette gate — not only the Settings panel's local
 *  `readyOnDevice`. Defaults false (safe: on-device slots stay deep-link
 *  only until a hook reports a ready model).
 *
 *  T20 (`ai:model-removed`) invalidates this cache after a successful
 *  removal; do not listen for that event here. */
const readyOnDevice: Record<OnDeviceKind, boolean> = { embed: false, llm: false }

/** Feed the credential cache — called by `useAIProviderConfig` after each refresh. */
export function cacheAiCredentials(creds: ProviderCredential[]): void {
  cachedCredentials = creds
  credentialsCached = true
}

/** Feed the on-device readiness cache — called from each catalog hook's
 *  `refresh()` and after an `ai:model-removed` drop so the palette shares
 *  the same `slotIsConnected` signal as Settings. */
export function cacheReadyOnDevice(kind: OnDeviceKind, ready: boolean): void {
  readyOnDevice[kind] = ready
}

/**
 * Imperative slot-connected check mirroring `AISettingsPanel.slotConnected`.
 * When the credential cache is populated, uses the full
 * `slotIsConnected` gate (credential registry + `addedProviders` +
 * `readyOnDevice[kind]`). Before credentials are loaded, falls back to
 * permissive `config != null`.
 */
function imperativeSlotConnected(
  config: { provider: string; hasApiKey: boolean } | null,
  kind: OnDeviceKind,
): boolean {
  if (!config) return false
  if (!credentialsCached) return true // Permissive fallback — same as UI pre-load
  const credentialByPreset = new Map(cachedCredentials.map((c) => [c.presetId, c]))
  const addedProviders = useUiStore.getState().addedProviders
  return slotIsConnected(config, credentialByPreset, addedProviders, readyOnDevice[kind])
}

/**
 * Non-reactive check: can the user flip this feature right now?
 *
 * Mirrors `AISettingsPanel.genFeatureState` logic with the full
 * credential-registry gate (when credentials have been cached):
 * - Most features need a generation slot connected + privacy accepted.
 * - `semantic_search` / `emotion_suggestions` need the embedding slot.
 * - `chat_rag` needs both generation + embedding.
 * - `image_generation` needs the image slot + image model set.
 * - `continue_writing` additionally needs persona enabled.
 */
export function isAiFeatureActionable(feature: AIFeature): boolean {
  const s = useAiSettingsStore.getState()
  if (!s.hydrated || !s.providersHydrated) return false

  const { providers, privacyAcceptedAt } = s
  const gen = providers.generation
  const img = providers.image
  const embed = providers.embedding

  switch (feature) {
    case 'semantic_search':
    case 'emotion_suggestions':
      return (
        imperativeSlotConnected(embed, 'embed') &&
        embed != null &&
        privacyCleared(embed.endpointClass, privacyAcceptedAt)
      )

    case 'image_generation':
      return (
        imperativeSlotConnected(img, 'llm') &&
        img != null &&
        privacyCleared(img.endpointClass, privacyAcceptedAt) &&
        img.imageModel !== ''
      )

    case 'chat_rag':
      return (
        imperativeSlotConnected(gen, 'llm') &&
        gen != null &&
        privacyCleared(gen.endpointClass, privacyAcceptedAt) &&
        imperativeSlotConnected(embed, 'embed') &&
        embed != null &&
        privacyCleared(embed.endpointClass, privacyAcceptedAt)
      )

    case 'continue_writing':
      if (!s.personaEnabled) return false
      return (
        imperativeSlotConnected(gen, 'llm') &&
        gen != null &&
        privacyCleared(gen.endpointClass, privacyAcceptedAt)
      )

    default:
      // All other features require the generation slot.
      return (
        imperativeSlotConnected(gen, 'llm') &&
        gen != null &&
        privacyCleared(gen.endpointClass, privacyAcceptedAt)
      )
  }
}

// ── Persona ───────────────────────────────────────────────────────────

/** Non-reactive read of the persona enabled flag. */
export function getPersonaEnabled(): boolean {
  return useAiSettingsStore.getState().personaEnabled
}

/**
 * Imperative persona toggle. Persists via the backend IPC, then patches
 * the store.
 */
export async function setPersonaEnabledImperative(enabled: boolean): Promise<void> {
  await persistPersonaEnabled(enabled)
  useAiSettingsStore.getState().setPersonaEnabled(enabled)
}

// ── User Memory master toggle ─────────────────────────────────────────

/** Non-reactive read of the user-memory master preference. */
export function getUserMemoryEnabled(): boolean {
  return useAiSettingsStore.getState().userMemoryEnabled
}

/** Whether the AI settings store has been hydrated (settings read once). */
export function isAiSettingsHydrated(): boolean {
  return useAiSettingsStore.getState().hydrated
}

/**
 * Imperative user-memory master toggle.
 * Uses the same `setAiFeature('user_memory', …)` IPC + store patch.
 */
export async function setUserMemoryEnabledImperative(enabled: boolean): Promise<void> {
  await setAiFeature('user_memory', enabled)
  useAiSettingsStore.getState().setFlag('user_memory', enabled)
}

// ── Daily Chat AI Title toggle ────────────────────────────────────────

/** Non-reactive read of the daily-chat AI-title preference. */
export function getDailyChatAiTitle(): boolean {
  return useAiSettingsStore.getState().dailyChatAiTitle
}

/** Imperative daily-chat AI-title toggle. */
export async function setDailyChatAiTitleImperative(enabled: boolean): Promise<void> {
  await persistDailyChatAiTitle(enabled)
  useAiSettingsStore.setState({ dailyChatAiTitle: enabled })
}
