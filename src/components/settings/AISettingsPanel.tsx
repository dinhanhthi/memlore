import {
  AlertCircle,
  AlertTriangle,
  Brain,
  CheckCircle2,
  HelpCircle,
  Minus,
  Plus,
  KeyRound,
  Layers,
  UserRound,
  Settings2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAIProviderConfig } from '../../hooks/useAIProviderConfig'
import { useDefaultSearchMode } from '../../hooks/useDefaultSearchMode'
import { useEmbeddingStatus } from '../../hooks/useEmbeddingStatus'
import { useOllamaInstalledModels } from '../../hooks/useOllamaInstalledModels'
import { getReadyLlmModels, useOnDeviceLlmModels } from '../../hooks/useOnDeviceLlmModels'
import { getReadyModels, useOnDeviceModels } from '../../hooks/useOnDeviceModels'
import { useShowMessageMeta } from '../../hooks/useShowMessageMeta'
import {
  buildConnectedProviderOptions,
  isPrivacyExemptClass,
  isAiSetupAttentionReady,
  modelsTabDotColor,
  providersTabDotColor,
  resolveAiSetupAttention,
  resolveSetupPrivacyReceipt,
  slotIsConnected,
  type AiModelSlotId,
  type AiSetupAttentionIssue,
} from '../../lib/aiProviderStatus'
import { RestoredScroll } from '../common/RestoredScroll'
import { cn } from '../../lib/cn'
import { errMsg } from '../../lib/errMsg'
import {
  getEmbeddingStatusLabel,
  getEmbeddingStatusToneClass,
} from '../../lib/embeddingStatusLabel'
import { buildModelOptions } from '../../lib/modelOptions'
import { useAiSettingsStore } from '../../stores/aiSettingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useUiStore, type AITab } from '../../stores/uiStore'
import {
  PROVIDER_PRESETS,
  getFeatureUsageMeta,
  getPreset,
  getPresetsByCapability,
  isHighUsageRisk,
  providerIsOnDevice,
  providerUsesSubprocess,
  type AIEmbedProviderConfig,
  type AIEmbedProviderConfigInput,
  type AIFeature,
  type AIGenProviderConfig,
  type AIGenProviderConfigInput,
  type AIImageProviderConfig,
  type AIImageProviderConfigInput,
  type DailyChatPersona,
  type EmotionSuggestionLanguage,
  type ModelSuggestion,
  type ProviderCapability,
  type ProviderCredential,
  type SetProviderResult,
} from '../../types/ai'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { ComboBox, type ComboBoxOption } from '../common/ComboBox'
import { Select, type SelectOption } from '../common/Select'
import { TextInput } from '../common/TextInput'
import { Tooltip } from '../common/Tooltip'
import { AIPrivacyNoticePanel } from './AIPrivacyNoticePanel'
import { FIELD_LABEL_CLASS } from './ApiKeyField'
import { BackfillRow } from './BackfillRow'
import { CliProviderHealthStatus } from './CliProviderHealthStatus'
import { DailyChatPersonaPicker } from './DailyChatPersonaPicker'
import { EmotionSuggestionLanguagePicker } from './EmotionSuggestionLanguagePicker'
import { FeaturePromptEditor } from './FeaturePromptEditor'
import { MemoriesSettings } from './MemoriesSettings'
import { PersonaSettings, type GenerationSlotStatus } from './PersonaSettings'
import { ProvidersTab } from './ProvidersTab'
import { ResponseLanguagePicker } from './ResponseLanguagePicker'
import { SettingsRow } from './SettingsRow'
import { SETTINGS_SURFACE_CARD } from './SettingsSurfaceCard'
import { SettingsTabList } from './SettingsTabList'
import { Toggle } from './Toggle'
import { useTabSlideDirection } from './useTabSlideDirection'

/**
 * AI Settings panel (Phase 6 v2 R11+).
 *
 * Five horizontal tabs:
 *   1. General   — AI response language
 *   2. Providers — Connected/Available provider lists + per-provider modal
 *   3. Models    — every provider+model slot: chat, image, and embedding
 *                  (the embedding card also carries the index controls)
 *   4. Features  — per-feature toggles gated on slot readiness
 *   5. Memory & Persona — memory provider + settings, and the persona group
 *
 * Credentials (endpoint, API key) are managed on the Providers tab, not
 * inline on the feature tabs — see `ProvidersTab.tsx`.
 *
 * The "Audit log" and "Usage" surfaces live in the Statistics view —
 * they are observability concerns, not configuration ones.
 *
 * Component tests are NOT written per CLAUDE.md — UI changes too fast.
 * The supporting hook (`useAIProviderConfig`) and backend commands carry
 * the test coverage instead.
 */

// ─── Tab IDs ─────────────────────────────────────────────────────────────────

const AI_TABS: { id: AITab; labelKey: string; defaultLabel: string; icon: LucideIcon }[] = [
  { id: 'general', labelKey: 'tabs.general', defaultLabel: 'General', icon: Settings2 },
  { id: 'providers', labelKey: 'tabs.providers', defaultLabel: 'Providers', icon: KeyRound },
  // One tab for every provider+model slot — chat, image, and embedding. It
  // absorbed the former standalone "Embedding" tab; `tabStore` rehydrate
  // migrates the retired `'embed'` id onto this one.
  { id: 'chat', labelKey: 'tabs.models', defaultLabel: 'Models', icon: Layers },
  { id: 'features', labelKey: 'tabs.features', defaultLabel: 'Features', icon: Sparkles },
  {
    id: 'memories',
    labelKey: 'tabs.memory',
    defaultLabel: 'Memory',
    icon: Brain,
  },
  // Persona is a separate feature from Memory — separate tab, and it stays
  // usable while the memory master toggle is off.
  {
    id: 'persona',
    labelKey: 'tabs.persona',
    defaultLabel: 'Persona',
    icon: UserRound,
  },
]

function aiTabId(id: AITab) {
  return `ai-tab-${id}`
}
function aiPanelId(id: AITab) {
  return `ai-panel-${id}`
}

// ─── Status dot helpers ───────────────────────────────────────────────────────
// Slot/tab colour formula + attention-issue derivation live in
// `lib/aiProviderStatus.ts` so the page banners and the tab dots can never
// disagree about what still needs attention.

function slotNeedsPrivacyNotice(
  config: AIGenProviderConfig | AIImageProviderConfig | AIEmbedProviderConfig | null | undefined,
): boolean {
  return config != null && !isPrivacyExemptClass(config.endpointClass)
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AISettingsPanel() {
  const { t } = useTranslation('ai')
  const {
    settings,
    refresh,
    providers,
    credentials,
    credentialsLoaded,
    loading,
    error,
    saveGeneration,
    saveImage,
    saveEmbedding,
    acceptPrivacy,
    setFeature,
    setDailyChatPrefs,
    setDailyChatAiTitlePref,
    setEmotionLanguage,
    setResponseLanguage,
  } = useAIProviderConfig()

  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.aiTab ?? 'chat'
  })
  const setAiExplainerOpen = useUiStore((s) => s.setEmbeddingExplainerOpen)
  const setActiveTab = (tab: AITab) => useTabStore.getState().updateActiveTab({ aiTab: tab })
  const slideDir = useTabSlideDirection(
    AI_TABS.map((t) => t.id),
    activeTab,
  )

  /** Action-level error (forget / setFeature). Cleared after next success. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [showReindexPrompt, setShowReindexPrompt] = useState(false)

  async function handleSetFeature(feature: AIFeature, enabled: boolean) {
    try {
      await setFeature(feature, enabled)
      setActionError(null)
    } catch (e) {
      setActionError(errMsg(e))
    }
  }

  const genConfig = providers?.generation ?? null
  const imageConfig = providers?.image ?? null
  const embedConfig = providers?.embedding ?? null
  const storeHydrated = useAiSettingsStore((s) => s.hydrated)
  const storePrivacyAcceptedAt = useAiSettingsStore((s) => s.privacyAcceptedAt)
  const setupPrivacy = resolveSetupPrivacyReceipt({
    hasSettings: settings != null,
    settingsPrivacyAcceptedAt: settings?.privacyAcceptedAt ?? null,
    storeHydrated,
    storePrivacyAcceptedAt,
  })
  const privacyAcceptedAt = setupPrivacy.acceptedAt
  const setupAttentionReady = isAiSetupAttentionReady({
    providersKnown: providers != null,
    privacyKnown: setupPrivacy.known,
  })

  /** Privacy side panel state. `null` = closed. */
  const [privacyPanelMode, setPrivacyPanelMode] = useState<'accept' | 'view' | null>(null)
  const privacyNoticeTriggerRef = useRef<HTMLElement | null>(null)

  function openPrivacyPanel(mode: 'accept' | 'view', trigger?: HTMLElement) {
    if (trigger) privacyNoticeTriggerRef.current = trigger
    setPrivacyPanelMode(mode)
  }

  async function handleAcceptPrivacy() {
    try {
      await acceptPrivacy()
      setPrivacyPanelMode(null)
      setActionError(null)
    } catch (e) {
      // Keep the panel OPEN on failure — closing it would require the
      // user to dig back through the footer banner just to retry. The
      // global error banner in the page footer surfaces the message;
      // the panel stays so a transient failure (e.g. DB locked) can be
      // retried with one click.
      setActionError(errMsg(e))
    }
  }

  // Hoist the Ollama probe so both ModelsSections share ONE
  // `/api/tags` request — previously each card called the hook on its
  // own, firing two parallel HTTP probes on first mount (cf-review C3).
  // The probe runs when EITHER slot's provider is currently Ollama.
  // Hook is called UNCONDITIONALLY here (before any early return) so
  // React's rules-of-hooks invariant holds across renders — the hook's
  // own gate parameter handles the no-op case.
  const isOllamaActive = genConfig?.provider === 'ollama' || embedConfig?.provider === 'ollama'
  const ollamaHook = useOllamaInstalledModels(isOllamaActive)
  const ollama: OllamaProbeState = {
    models: ollamaHook.models,
    loading: ollamaHook.loading,
    unreachable: ollamaHook.unreachable,
  }

  // ── Per-slot "connected on THIS device" ──────────────────────────────────
  // A slot's provider/model selection syncs across devices; the credential
  // that makes it callable does not. So `config != null` says nothing about
  // whether this device can actually use the slot — `slotIsConnected` does.
  // Drives the Providers-tab dot, every feature gate, the RAG index status,
  // and the Persona warning, so all four agree by construction.
  const addedProviders = useUiStore((s) => s.addedProviders)
  const credentialByPreset = useMemo(() => {
    const map = new Map<string, ProviderCredential>()
    for (const c of credentials) map.set(c.presetId, c)
    return map
  }, [credentials])
  // Same duplicate-subscription trade-off `ModelsSection` documents below:
  // every AI Settings tab stays mounted, so sharing one instance would need a
  // larger refactor than this fix warrants. Removal stays in sync via
  // `ai:model-removed` (both hook instances listen and drop the id).
  const panelOnDeviceEmbed = useOnDeviceModels()
  const panelOnDeviceLlm = useOnDeviceLlmModels()
  const readyOnDevice = useMemo(
    () => ({
      embed: getReadyModels(panelOnDeviceEmbed.catalog, panelOnDeviceEmbed.states).length > 0,
      llm: getReadyLlmModels(panelOnDeviceLlm.catalog, panelOnDeviceLlm.states).length > 0,
    }),
    [
      panelOnDeviceEmbed.catalog,
      panelOnDeviceEmbed.states,
      panelOnDeviceLlm.catalog,
      panelOnDeviceLlm.states,
    ],
  )
  const slotConnected = useCallback(
    (config: { provider: string; hasApiKey: boolean } | null, kind: 'embed' | 'llm') =>
      // Until the credential registry has been read once, an empty
      // `credentialByPreset` is indistinguishable from "nothing connected".
      // Reading it as disconnected would disable the entire AI page — on
      // first paint, and permanently if that one IPC ever fails. Fall back
      // to the old permissive check until we actually know.
      credentialsLoaded
        ? slotIsConnected(config, credentialByPreset, addedProviders, readyOnDevice[kind])
        : config != null,
    [credentialsLoaded, credentialByPreset, addedProviders, readyOnDevice],
  )
  const genConnected = slotConnected(genConfig, 'llm')
  const imageConnected = slotConnected(imageConfig, 'llm')
  const embedConnected = slotConnected(embedConfig, 'embed')
  const anyProviderConnected = genConnected || imageConnected || embedConnected
  // Persona needs more than a boolean: "no chat model picked yet" and "picked
  // but no credential here" send the user to different tabs. `'unknown'` while
  // either input is still loading — `providers` is null until
  // `providersHydrated`, and `credentialsLoaded` guards the registry — so the
  // tab never warns on a device that is merely still reading.
  const generationStatus: GenerationSlotStatus =
    providers == null || !credentialsLoaded
      ? 'unknown'
      : genConfig == null
        ? 'not_selected'
        : genConnected
          ? 'connected'
          : 'not_connected'

  // Shared with the page banners — one formula so a yellow tab never appears
  // without an explanation of what is still missing.
  const slotAttentionInput = useMemo(
    () => ({
      gen: { config: genConfig, connected: genConnected },
      image: { config: imageConfig, connected: imageConnected },
      embed: { config: embedConfig, connected: embedConnected },
      privacyAcceptedAt,
    }),
    [
      genConfig,
      imageConfig,
      embedConfig,
      genConnected,
      imageConnected,
      embedConnected,
      privacyAcceptedAt,
    ],
  )
  const modelsDotColor = useMemo(
    () => (setupAttentionReady ? modelsTabDotColor(slotAttentionInput) : 'bg-empty'),
    [setupAttentionReady, slotAttentionInput],
  )
  const providersDotColor = useMemo(
    () =>
      setupAttentionReady ? providersTabDotColor(modelsDotColor, anyProviderConnected) : 'bg-empty',
    [setupAttentionReady, modelsDotColor, anyProviderConnected],
  )
  const setupAttention = useMemo(
    () => (setupAttentionReady ? resolveAiSetupAttention(slotAttentionInput) : []),
    [setupAttentionReady, slotAttentionInput],
  )

  const aiTabOptions = useMemo(
    () =>
      AI_TABS.map((tab) => {
        // Models owns all three provider slots; Providers folds in the Models
        // warning so a half-connected / privacy-blocked / missing-embedding
        // setup never shows green on one tab and yellow on the other.
        const showDot = setupAttentionReady && (tab.id === 'chat' || tab.id === 'providers')
        const dotColor = tab.id === 'providers' ? providersDotColor : modelsDotColor
        const label = t(tab.labelKey, { defaultValue: tab.defaultLabel })
        const Icon = tab.icon
        return {
          id: tab.id,
          ariaLabel: label,
          label: (
            <>
              {showDot && (
                <span className={cn('size-2 shrink-0 rounded-full', dotColor)} aria-hidden="true" />
              )}
              <Icon className="hidden size-4 shrink-0 @max-[640px]:block" aria-hidden="true" />
              <span className="truncate whitespace-nowrap @max-[640px]:hidden" aria-hidden="true">
                {label}
              </span>
            </>
          ),
        }
      }),
    [t, modelsDotColor, providersDotColor, setupAttentionReady],
  )

  if (loading && !settings && !providers) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-fg-secondary text-sm">{t('settings_panel.loading')}</span>
      </div>
    )
  }

  return (
    <div className="@container flex h-full flex-col overflow-hidden">
      {/* ── Page title (not sticky) ────────────────────────────────────────── */}
      <div className="shrink-0 px-6 pt-6 pb-3">
        <div className="flex items-center gap-2">
          <h1 className="font-title text-fg text-3xl font-extrabold">
            {t('page.ai_settings_title', { defaultValue: 'AI Settings' })}
          </h1>
          {/* Page-level entry point for the general "How AI works" explainer —
              hangs off the page title (mirroring Security), not a single card. */}
          <button
            type="button"
            onClick={() => setAiExplainerOpen(true)}
            aria-label={t('embedding_explainer.help_aria')}
            className="text-fg-muted hover:text-accent hover:bg-accent-soft inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none"
          >
            <HelpCircle className="size-5" strokeWidth={1.75} />
          </button>
        </div>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('page.ai_settings_description', {
            defaultValue: 'Configure providers and per-feature toggles for AI-powered features.',
          })}
        </p>
      </div>

      {/* ── Setup attention banners ────────────────────────────────────────
          One banner per unresolved issue from `resolveAiSetupAttention` —
          the same rule set that colours the Providers/Models tab dots.
          Covers: nothing connected (T3.6), privacy receipt missing, slots
          chosen-but-not-connected on this device, and chat-ready-but-no-
          embedding. Purely derived; no dismissal. Held until
          `setupAttentionReady` so a remount (Settings → AI) cannot flash
          the privacy Callout from an unread local `settings` snapshot. */}
      {setupAttention.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 px-6 pb-3">
          {setupAttention.map((issue) => (
            <AiSetupAttentionBanner
              key={issue.kind}
              issue={issue}
              onGoProviders={() => setActiveTab('providers')}
              onGoModels={() => setActiveTab('chat')}
              onReviewPrivacy={() => openPrivacyPanel('accept')}
            />
          ))}
        </div>
      )}

      <SettingsTabList
        tabs={aiTabOptions}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.ai')}
        tabId={aiTabId}
        panelId={aiPanelId}
        tabClassName="min-w-0"
      />

      {/* ── Tabpanels (all mounted; hidden via display) ──────────────────────
       *
       * Mounting all panels at once preserves per-tab scroll position when
       * the user switches tabs. `display: none` removes the inactive panel
       * from the layout, but we add `inert` + `aria-hidden` so:
       *   - Focus cannot land inside a hidden panel via Tab / programmatic
       *     focus / browser autofill (cf-review C2).
       *   - Screen readers skip the hidden DOM subtree explicitly.
       *   - Form controls inside hidden panels are not submitted on Enter.
       *
       * `inert` is supported in all modern browsers (~93%+ as of 2026-05);
       * pre-`inert` browsers still get the `display: none` + `aria-hidden`
       * which is correct in practice for keyboard nav. */}
      <div className="min-h-0 flex-1">
        {AI_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`ai:${tab.id}`}
              id={aiPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={aiTabId(tab.id)}
              aria-hidden={!isActive}
              inert={!isActive}
              tabIndex={0}
              style={{ display: isActive ? 'block' : 'none' }}
              className={cn(
                'h-full overflow-y-auto p-6 outline-none',
                isActive && slideDir === 'right' && 'tab-slide-in-right',
                isActive && slideDir === 'left' && 'tab-slide-in-left',
              )}
            >
              {tab.id === 'general' && (
                <div className="max-w-180 space-y-3">
                  <GeneralTab
                    responseLanguage={settings?.responseLanguage ?? 'auto'}
                    setResponseLanguage={setResponseLanguage}
                    onError={setActionError}
                  />
                </div>
              )}

              {tab.id === 'providers' && (
                <div className="max-w-180">
                  <ProvidersTab
                    onError={setActionError}
                    onPrivacyPrompt={() => openPrivacyPanel('accept')}
                  />
                </div>
              )}

              {tab.id === 'chat' && (
                <div className="max-w-180 space-y-3">
                  <ModelsSection
                    role="chat"
                    config={genConfig}
                    save={saveGeneration}
                    credentials={credentials}
                    onPrivacyPrompt={() => openPrivacyPanel('accept')}
                    onError={setActionError}
                    ollama={ollama}
                    embedConfigured={embedConnected}
                  />
                  {/* Independent slot — the provider that writes best prose
                      is rarely the one that draws best. */}
                  <ModelsSection
                    role="image"
                    config={imageConfig}
                    save={saveImage}
                    credentials={credentials}
                    onPrivacyPrompt={() => openPrivacyPanel('accept')}
                    onError={setActionError}
                    ollama={ollama}
                  />
                  {/* The embedding slot carries its index controls inside the
                      same card — the model and the index it produces are one
                      decision, not two. */}
                  <ModelsSection
                    role="embed"
                    config={embedConfig}
                    save={saveEmbedding}
                    credentials={credentials}
                    onPrivacyPrompt={() => openPrivacyPanel('accept')}
                    onError={setActionError}
                    onEmbedModelChanged={() => setShowReindexPrompt(true)}
                    ollama={ollama}
                    footer={
                      embedConfig != null ? (
                        <BackfillRow
                          bare
                          showReindexPrompt={showReindexPrompt}
                          onDismissReindexPrompt={() => setShowReindexPrompt(false)}
                        />
                      ) : null
                    }
                  />
                </div>
              )}

              {tab.id === 'features' && (
                <div className="max-w-180">
                  <FeaturesTab
                    refresh={refresh}
                    settings={settings}
                    genConfig={genConfig}
                    imageConfig={imageConfig}
                    embedConfig={embedConfig}
                    genConnected={genConnected}
                    imageConnected={imageConnected}
                    embedConnected={embedConnected}
                    onToggle={handleSetFeature}
                    onError={setActionError}
                    setDailyChatPrefs={setDailyChatPrefs}
                    setDailyChatAiTitlePref={setDailyChatAiTitlePref}
                    setEmotionLanguage={setEmotionLanguage}
                  />
                </div>
              )}

              {tab.id === 'memories' && (
                <div className="max-w-180">
                  <MemoriesSettings
                    onPrivacyPrompt={() => openPrivacyPanel('accept')}
                    credentials={credentials}
                  />
                </div>
              )}

              {tab.id === 'persona' && (
                <div className="max-w-180">
                  <PersonaSettings
                    onChanged={() => refresh()}
                    generationStatus={generationStatus}
                  />
                </div>
              )}
            </RestoredScroll>
          )
        })}
      </div>

      {/* ── Page footer: errors + privacy (fixed to bottom of AI page) ─── */}
      <AIPageFooter
        error={actionError ?? error}
        privacyAcceptedAt={privacyAcceptedAt}
        showReviewPrompt={
          slotNeedsPrivacyNotice(genConfig) ||
          slotNeedsPrivacyNotice(imageConfig) ||
          slotNeedsPrivacyNotice(embedConfig)
        }
        onViewPrivacy={(trigger) =>
          openPrivacyPanel(privacyAcceptedAt != null ? 'view' : 'accept', trigger)
        }
      />

      <AIPrivacyNoticePanel
        open={privacyPanelMode != null}
        mode={privacyPanelMode ?? 'view'}
        onAccept={handleAcceptPrivacy}
        onClose={() => setPrivacyPanelMode(null)}
        triggerRef={privacyNoticeTriggerRef}
      />
    </div>
  )
}

// ─── Setup attention banners ─────────────────────────────────────────────────

const SLOT_LABEL_KEY: Record<AiModelSlotId, string> = {
  chat: 'setup_attention.slot_chat',
  image: 'setup_attention.slot_image',
  embed: 'setup_attention.slot_embed',
}

/** One explanatory warning matching a `resolveAiSetupAttention` issue.
 *  Layout mirrors the original T3.6 no-providers banner so partial-setup
 *  warnings feel like the same system, not a second design language. */
function AiSetupAttentionBanner({
  issue,
  onGoProviders,
  onGoModels,
  onReviewPrivacy,
}: {
  issue: AiSetupAttentionIssue
  onGoProviders: () => void
  onGoModels: () => void
  onReviewPrivacy: () => void
}) {
  const { t } = useTranslation('ai')

  let title: string
  let body: string
  let actionLabel: string
  let onAction: () => void

  switch (issue.kind) {
    case 'no_provider':
      title = t('no_providers_banner.title')
      body = t('no_providers_banner.body')
      actionLabel = t('no_providers_banner.action')
      onAction = onGoProviders
      break
    case 'privacy':
      title = t('setup_attention.privacy.title')
      body = t('setup_attention.privacy.body')
      actionLabel = t('setup_attention.privacy.action')
      onAction = onReviewPrivacy
      break
    case 'slots_not_connected': {
      const slots = issue.slots
        .map((id) => t(SLOT_LABEL_KEY[id]))
        .join(t('setup_attention.slot_list_sep'))
      title = t('setup_attention.slots_not_connected.title')
      body = t('setup_attention.slots_not_connected.body', { slots })
      actionLabel = t('setup_attention.slots_not_connected.action')
      onAction = onGoProviders
      break
    }
    case 'embed_not_configured':
      title = t('setup_attention.embed_not_configured.title')
      body = t('setup_attention.embed_not_configured.body')
      actionLabel = t('setup_attention.embed_not_configured.action')
      onAction = onGoModels
      break
  }

  return (
    <Callout
      tone="warning"
      title={title}
      action={
        <Button variant="secondary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      }
    >
      {body}
    </Callout>
  )
}

// ─── AI page footer ──────────────────────────────────────────────────────────

/** Fixed footer for the AI settings page (mirrors Data page footer).
 *  Surfaces global errors and the privacy notice link — no boxed cards.
 *
 *  It deliberately does NOT list the selected chat/image/embedding models:
 *  the app footer's own AI button (`AIProviderInfoPopover`) already shows
 *  the active setup from every screen, so repeating it here was duplication
 *  the user only ever saw while already inside AI Settings. */
function AIPageFooter({
  error,
  privacyAcceptedAt,
  showReviewPrompt,
  onViewPrivacy,
}: {
  error: string | null
  privacyAcceptedAt: number | null
  showReviewPrompt: boolean
  onViewPrivacy: (trigger: HTMLElement) => void
}) {
  const { t } = useTranslation('ai')

  const privacyRow =
    privacyAcceptedAt != null ? (
      <div className="text-fg-muted hover:text-fg flex items-start gap-2 transition-colors">
        <CheckCircle2 className="text-success-text mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p className="leading-snug">
          {t('privacy_top_banner.already_accepted_prefix', {
            defaultValue: 'You already accepted ',
          })}
          <button
            type="button"
            onClick={(e) => onViewPrivacy(e.currentTarget)}
            className="text-accent hover:text-accent-hover font-medium underline"
            aria-label={t('privacy_top_banner.aria_view_notice', {
              defaultValue: 'Open the AI privacy notice',
            })}
          >
            {t('privacy_top_banner.already_accepted_link', {
              defaultValue: 'the AI privacy notice',
            })}
          </button>
        </p>
      </div>
    ) : showReviewPrompt ? (
      <button
        type="button"
        onClick={(e) => onViewPrivacy(e.currentTarget)}
        className={cn(
          'text-fg-muted hover:text-fg inline-flex items-center gap-1.5 leading-snug underline transition-colors',
          'rounded-sm outline-none',
        )}
        aria-label={t('privacy_top_banner.aria_review', {
          defaultValue: 'Review the AI privacy notice before using a non-local provider.',
        })}
      >
        <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
        {t('privacy_top_banner.review_notice', {
          defaultValue: 'Review the AI privacy notice',
        })}
      </button>
    ) : null

  if (!error && privacyRow == null) return null

  return (
    <div className="border-border-default surface-soft:border-border-default flex shrink-0 flex-col gap-1.5 border-t px-6 py-2.5 text-xs">
      {error && (
        <div className="text-danger-text flex items-start gap-2" role="alert">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="leading-snug">{error}</span>
        </div>
      )}
      {privacyRow}
    </div>
  )
}

// ─── ModelsSection ────────────────────────────────────────────────────────────
//
// Formerly `ProviderCard`, which also owned the endpoint/API-key form and
// its Save/Test/Forget credential handlers (T2.6-era "Connection" card).
// Phase 3 moved credential management — including the Test button — to the
// dedicated Providers tab (`ProvidersTab.tsx`, per-preset
// `saveCredential`/`testCredential`/`forgetCredential`), so this component
// now owns ONLY the provider+model SELECTION for a slot (`ProviderPicker`
// from T4.1 + `ModelField` / `OnDeviceModelField` from T4.2) and the
// per-slot provider+model save — there is no endpoint/API-key form and no
// Test button here anymore.

/** Result of the hoisted `useOllamaInstalledModels` call, passed down
 *  to whichever ModelsSection's preset is currently Ollama. Hoisting
 *  prevents two parallel `/api/tags` probes when both cards default
 *  to Ollama on first mount. */
interface OllamaProbeState {
  models: Array<{
    name: string
    kind: 'chat' | 'embedding'
    parameterSize?: string
    family?: string
    quantization?: string
  }>
  loading: boolean
  unreachable: boolean
}

interface ModelsSectionChatProps {
  role: 'chat'
  config: AIGenProviderConfig | null
  save: (input: AIGenProviderConfigInput) => Promise<SetProviderResult>
  /** Every preset's per-preset credential registry row (T1.6), passed
   *  through to `ProviderPicker` so it can tell which presets are
   *  "Needs API key" without re-fetching. */
  credentials: ProviderCredential[]
  /** Called after a save that lands on a class the user has not yet
   *  accepted. The parent surfaces the global privacy modal pre-set
   *  to that class. */
  onPrivacyPrompt: () => void
  onError: (msg: string | null) => void
  ollama: OllamaProbeState
  /** True iff the embedding slot has a configured provider. Drives
   *  the "pair this CLI with an embed provider" hint on subprocess
   *  providers. */
  embedConfigured: boolean
}

interface ModelsSectionImageProps {
  role: 'image'
  config: AIImageProviderConfig | null
  save: (input: AIImageProviderConfigInput) => Promise<SetProviderResult>
  credentials: ProviderCredential[]
  onPrivacyPrompt: () => void
  onError: (msg: string | null) => void
  ollama: OllamaProbeState
}

interface ModelsSectionEmbedProps {
  role: 'embed'
  config: AIEmbedProviderConfig | null
  save: (input: AIEmbedProviderConfigInput) => Promise<SetProviderResult>
  credentials: ProviderCredential[]
  onPrivacyPrompt: () => void
  onError: (msg: string | null) => void
  onEmbedModelChanged?: () => void
  ollama: OllamaProbeState
  /** Extra sections appended INSIDE this section's card, edge-to-edge. Used to
   *  keep the embedding-index controls on the same surface as the model that
   *  produces the index. */
  footer?: ReactNode
}

type ModelsSectionProps = ModelsSectionChatProps | ModelsSectionImageProps | ModelsSectionEmbedProps

function ModelsSection(props: ModelsSectionProps) {
  const { t } = useTranslation('ai')
  const { role, config, save, credentials, onPrivacyPrompt, onError, ollama } = props

  const capability: ProviderCapability =
    role === 'chat' ? 'chat' : role === 'image' ? 'image' : 'embed'

  // Draft state — lives here, not in parent
  const [presetId, setPresetId] = useState<string>(() =>
    getDefaultPresetIdForCapability(capability),
  )
  const [chatModel, setChatModel] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [saving, setSaving] = useState(false)

  // Track in-flight save state via a ref so the hydration effect can
  // observe it without re-running when it flips. Resetting form state
  // mid-save would wipe whatever the user is picking while the save
  // promise is pending (cf-review I10).
  const savingRef = useRef(false)

  // Hydrate from saved config on mount / when config changes.
  // Skipped while a save is in flight — `refresh()` updates `providers`
  // before the save promise resolves, which would otherwise clobber
  // any in-progress edit the user made between Save click and the
  // refresh's `setSettings` callback.
  useEffect(() => {
    if (savingRef.current) return
    if (!config) {
      const preset = getPreset(getDefaultPresetIdForCapability(capability))!
      setPresetId(preset.id)
      if (role === 'chat') {
        setChatModel(preset.chatModel)
      } else if (role === 'image') {
        setImageModel(preset.imageModel ?? '')
      } else {
        setEmbeddingModel(preset.embeddingModel)
      }
      return
    }
    const preset = getPreset(config.provider) ?? getPreset('custom')!
    setPresetId(preset.id)
    if (role === 'chat') {
      setChatModel((config as AIGenProviderConfig).chatModel ?? '')
    } else if (role === 'image') {
      setImageModel((config as AIImageProviderConfig).imageModel ?? '')
    } else {
      setEmbeddingModel((config as AIEmbedProviderConfig).embeddingModel ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, capability])

  const preset = useMemo(() => getPreset(presetId) ?? getPreset('custom')!, [presetId])

  // Ollama installed-models list arrives via the `ollama` prop from
  // the parent (hoisted hook). See note on the props type above.

  const installedChatModels = useMemo<ComboBoxOption[]>(
    () =>
      ollama.models
        .filter((m) => m.kind === 'chat')
        .map((m) => ({
          value: m.name,
          description:
            [m.parameterSize, m.family, m.quantization].filter(Boolean).join(' · ') || undefined,
        })),
    [ollama.models],
  )

  const installedEmbeddingModels = useMemo<ComboBoxOption[]>(
    () =>
      ollama.models
        .filter((m) => m.kind === 'embedding')
        .map((m) => ({
          value: m.name,
          description:
            [m.parameterSize, m.family, m.quantization].filter(Boolean).join(' · ') || undefined,
        })),
    [ollama.models],
  )

  // On-device model catalogs (T4.2). Called unconditionally regardless of
  // `role`/preset — `role` is fixed per call site, so conditionally calling
  // one or the other would violate the rules of hooks. Both hooks already
  // fetch on mount for the Providers tab's own catalog modal; this is a
  // second, independent subscription (all AI Settings tabs stay mounted at
  // once — see the tabpanel comment below — so there is no way to share the
  // instance without a larger refactor, which is out of scope here).
  const onDeviceEmbedModels = useOnDeviceModels()
  const onDeviceLlmModels = useOnDeviceLlmModels()
  const readyEmbeddingModels = useMemo(
    () => getReadyModels(onDeviceEmbedModels.catalog, onDeviceEmbedModels.states),
    [onDeviceEmbedModels.catalog, onDeviceEmbedModels.states],
  )
  const readyChatModels = useMemo(
    () => getReadyLlmModels(onDeviceLlmModels.catalog, onDeviceLlmModels.states),
    [onDeviceLlmModels.catalog, onDeviceLlmModels.states],
  )

  // ── Dirty tracking ───────────────────────────────────────────────
  // Save is disabled when the in-form draft matches the saved config
  // byte-for-byte. When no slot is configured yet (`!config`), every
  // initial save is a real change, so dirty defaults to true. Credentials
  // (endpoint/API key) are no longer part of this form — they live on the
  // Providers tab — so dirty tracking only looks at provider + model.
  const isDirty = useMemo(() => {
    if (!config) return true
    if (config.provider !== preset.id) return true
    if (role === 'chat') {
      const cfg = config as AIGenProviderConfig
      if ((cfg.chatModel ?? '').trim() !== chatModel.trim()) return true
    } else if (role === 'image') {
      const cfg = config as AIImageProviderConfig
      if ((cfg.imageModel ?? '').trim() !== imageModel.trim()) return true
    } else {
      const cfg = config as AIEmbedProviderConfig
      if ((cfg.embeddingModel ?? '').trim() !== embeddingModel.trim()) return true
    }
    return false
  }, [config, preset.id, role, chatModel, imageModel, embeddingModel])

  function handlePresetChange(id: string) {
    setPresetId(id)
    const next = getPreset(id)
    if (next) {
      // If the user is switching BACK to the originally-saved preset,
      // re-hydrate the fields from `config` rather than the preset
      // defaults. Otherwise a customised model gets silently reverted on
      // a preset round-trip (away → back), leaving Save enabled with no
      // visible change from the user's perspective.
      const restoringSaved = config != null && config.provider === id
      if (role === 'chat') {
        const cfg = config as AIGenProviderConfig | null
        setChatModel(restoringSaved && cfg ? (cfg.chatModel ?? '') : next.chatModel)
      } else if (role === 'image') {
        const cfg = config as AIImageProviderConfig | null
        setImageModel(restoringSaved && cfg ? (cfg.imageModel ?? '') : (next.imageModel ?? ''))
      } else {
        const cfg = config as AIEmbedProviderConfig | null
        setEmbeddingModel(restoringSaved && cfg ? (cfg.embeddingModel ?? '') : next.embeddingModel)
      }
    }
  }

  // T2.6 cutover: `AIGenProviderConfigInput` / `AIEmbedProviderConfigInput`
  // no longer carry `endpoint` / `apiKey` — the backend resolves those from
  // the per-preset credential registry (managed on the Providers tab) by
  // provider id.
  function buildChatInput(): AIGenProviderConfigInput {
    return {
      provider: preset.id,
      chatModel: chatModel.trim(),
    }
  }

  function buildImageInput(): AIImageProviderConfigInput {
    return {
      provider: preset.id,
      imageModel: imageModel.trim(),
    }
  }

  function buildEmbedInput(): AIEmbedProviderConfigInput {
    return {
      provider: preset.id,
      embeddingModel: embeddingModel.trim(),
    }
  }

  async function handleSave() {
    setSaving(true)
    savingRef.current = true
    const embedCfg = role === 'embed' ? (config as AIEmbedProviderConfig | null) : null
    const embedModelChanged =
      role === 'embed' &&
      embedCfg != null &&
      (embedCfg.provider !== preset.id ||
        (embedCfg.embeddingModel ?? '').trim() !== embeddingModel.trim())
    try {
      const result: SetProviderResult =
        role === 'chat'
          ? await (save as ModelsSectionChatProps['save'])(buildChatInput())
          : role === 'image'
            ? await (save as ModelsSectionImageProps['save'])(buildImageInput())
            : await (save as ModelsSectionEmbedProps['save'])(buildEmbedInput())
      if (embedModelChanged && role === 'embed') {
        props.onEmbedModelChanged?.()
      }
      // The slot landed on a class the user has not yet accepted —
      // surface the global modal pre-set to that class so the user
      // accepts once, panel-wide.
      if (result.requiresPrivacyConsent) {
        onPrivacyPrompt()
      }
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    } finally {
      // Release the hydration block AFTER the next microtask so the
      // refresh()-driven `providers` update has already propagated
      // into `config` and either (a) triggered the effect with the
      // new shape (post-save state from disk), or (b) been skipped
      // because `config` didn't change.
      setSaving(false)
      queueMicrotask(() => {
        savingRef.current = false
      })
    }
  }

  // Heading names the slot, so the dropdowns need no labels of their own.
  const sectionTitle =
    role === 'chat'
      ? t('field.chat_model')
      : role === 'image'
        ? t('field.image_model')
        : t('field.embedding_model')

  // The model dropdown only offers *usable* models for the selected
  // provider:
  //   - on-device / on-device-llm → downloaded-and-ready models only
  //   - ollama → installed models from `/api/tags` only (not pull-list
  //     suggestions the user would still need to download)
  //   - hosted / CLI → the preset's curated supported-model list
  //   - other local (LM Studio / llama-server / custom) → free text when
  //     no curated list exists
  // `label` still feeds `aria-label`; `hideLabel` drops the label column so
  // the provider + model dropdowns sit side by side in one row.
  // On-device presets are chat- or embedding-only — neither generates
  // images — so the image role always takes the regular `ModelField` path.
  const isOllama = preset.id === 'ollama'
  const modelField =
    providerIsOnDevice(preset.id) && role !== 'image' ? (
      role === 'chat' ? (
        <OnDeviceModelField
          label={sectionTitle}
          hideLabel
          value={chatModel}
          onChange={setChatModel}
          readyModels={readyChatModels.map((m) => ({ id: m.id, label: m.display_name }))}
          providersPresetId="on-device-llm"
        />
      ) : (
        <OnDeviceModelField
          label={sectionTitle}
          hideLabel
          value={embeddingModel}
          onChange={setEmbeddingModel}
          readyModels={readyEmbeddingModels.map((m) => ({ id: m.id, label: m.displayName }))}
          providersPresetId="on-device"
        />
      )
    ) : (
      <ModelField
        label={sectionTitle}
        hideLabel
        value={role === 'chat' ? chatModel : role === 'image' ? imageModel : embeddingModel}
        onChange={
          role === 'chat' ? setChatModel : role === 'image' ? setImageModel : setEmbeddingModel
        }
        // Hosted/CLI: curated supported models. Ollama: none — only
        // installed (see `installed` below) are actually callable.
        suggestions={
          isOllama
            ? undefined
            : role === 'chat'
              ? preset.chatModelSuggestions
              : role === 'image'
                ? preset.imageModelSuggestions
                : preset.embeddingModelSuggestions
        }
        // Ollama installed list only when Ollama is the active preset —
        // never leak local Ollama names into a hosted/CLI model list.
        installed={
          isOllama
            ? role === 'chat'
              ? installedChatModels
              : role === 'embed'
                ? installedEmbeddingModels
                : undefined
            : undefined
        }
        ollamaUnreachable={isOllama && ollama.unreachable && !ollama.loading}
      />
    )

  return (
    <SettingCard
      title={sectionTitle}
      warning={
        role === 'chat' && providerUsesSubprocess(preset.id) ? t('cli_slow_warning') : undefined
      }
    >
      {/* One compact row: provider + model + Save. No field labels — the
          section heading already names the slot. Credential Test lives on
          the Providers tab; save failures go to the page footer banner. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-0 flex-1 basis-48">
          <ProviderModelRow
            provider={
              <ProviderPicker
                value={presetId}
                onChange={handlePresetChange}
                capability={capability}
                credentials={credentials}
                readyOnDevice={{
                  embed: readyEmbeddingModels.length > 0,
                  llm: readyChatModels.length > 0,
                }}
              />
            }
            model={modelField}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          loading={saving}
          onClick={handleSave}
          disabled={saving || !isDirty}
          title={
            !isDirty
              ? t('action.save_no_changes', { defaultValue: 'No unsaved changes' })
              : undefined
          }
        >
          {saving ? t('action.saving') : t('action.save')}
        </Button>
      </div>

      {/* Live status, NOT description — these stay. */}
      {role === 'chat' && (
        <>
          <CliProviderHealthStatus providerId={preset.id} model={chatModel} />
          {/* CLI providers are chat-only — semantic search and emotion
              suggestions need a separately-configured embedding provider.
              Surface this proactively so the user doesn't enable a feature
              toggle and then find it greyed out on the Features tab. */}
          {providerUsesSubprocess(preset.id) &&
            !('embedConfigured' in props && props.embedConfigured) && (
              <div className="border-accent/25 bg-accent-soft text-fg-muted rounded-xl border px-3 py-2 text-xs leading-relaxed">
                {t('embed_slot_pair_hint', {
                  defaultValue:
                    '💡 {{label}} is chat-only. To unlock semantic search, emotion suggestions, and using your entries in Daily Chat, configure an embedding provider (Voyage / Ollama / OpenAI) on the Models tab.',
                  label: preset.label,
                })}
              </div>
            )}
        </>
      )}

      {role === 'embed' && 'footer' in props && props.footer}
    </SettingCard>
  )
}

// ─── FeaturesTab ──────────────────────────────────────────────────────────────

interface FeaturesTabProps {
  settings: import('../../types/ai').AIFullSettings | null
  genConfig: AIGenProviderConfig | null
  imageConfig: AIImageProviderConfig | null
  embedConfig: AIEmbedProviderConfig | null
  /** Per-slot "usable on THIS device" — see `slotIsConnected`. A slot can be
   *  configured (synced provider + model) while having no credential here. */
  genConnected: boolean
  imageConnected: boolean
  embedConnected: boolean
  refresh: () => Promise<void>
  onToggle: (feature: AIFeature, enabled: boolean) => Promise<void>
  onError: (msg: string | null) => void
  setDailyChatPrefs: (persona: string, customPersona: string) => Promise<void>
  setDailyChatAiTitlePref: (enabled: boolean) => Promise<void>
  setEmotionLanguage: (language: string) => Promise<void>
}

/** Show the "many entries pending" RAG-group warning once the queue crosses
 *  this size — a handful of pending edits from normal writing is not worth
 *  flagging; this threshold catches a queue that has fallen meaningfully
 *  behind. */
const RAG_PENDING_WARNING_THRESHOLD = 20

function FeaturesTab({
  settings,
  genConfig,
  imageConfig,
  embedConfig,
  genConnected,
  imageConnected,
  embedConnected,
  refresh,
  onToggle,
  onError,
  setDailyChatPrefs,
  setDailyChatAiTitlePref,
  setEmotionLanguage,
}: FeaturesTabProps) {
  const { t } = useTranslation('ai')
  const {
    status: ragStatus,
    pendingCount: ragPendingCount,
    downloadProgress: ragDownloadProgress,
  } = useEmbeddingStatus()
  const {
    showMessageMeta,
    loading: showMessageMetaLoading,
    setShowMessageMeta,
  } = useShowMessageMeta()

  const privacyAcceptedAt = settings?.privacyAcceptedAt ?? null
  // "Configured" means the slot is genuinely usable HERE, not merely that a
  // provider row exists. The row syncs; the credential does not. Every gate
  // below checks this BEFORE the privacy gate — telling a user to accept the
  // privacy notice when the real blocker is a missing API key sends them down
  // a path that cannot unblock anything.
  const genConfigured = genConnected
  const imagePrivacyAccepted =
    imageConfig != null &&
    (isPrivacyExemptClass(imageConfig.endpointClass) || privacyAcceptedAt != null)
  const genPrivacyAccepted =
    genConfig != null &&
    (isPrivacyExemptClass(genConfig.endpointClass) || privacyAcceptedAt != null)
  const embedConfigured = embedConnected
  const embedPrivacyAccepted =
    embedConfig != null &&
    (isPrivacyExemptClass(embedConfig.endpointClass) || privacyAcceptedAt != null)
  // Image generation only exists for presets whose capabilities include
  // 'image' (e.g. on-device-llm is chat-only). Hide the toggle entirely
  // for an incapable provider rather than showing it permanently disabled
  // with a "needs an image model" hint the user has no way to satisfy.
  const genSupportsImage = genConfig
    ? (getPreset(genConfig.provider)?.capabilities.includes('image') ?? true)
    : true

  /** Compute the disabled state + hint for each feature. */
  function genFeatureState(feature: AIFeature): { disabled: boolean; hint: string | undefined } {
    switch (feature) {
      case 'semantic_search':
      case 'emotion_suggestions':
        if (!embedConfigured)
          return {
            disabled: true,
            hint: t('feature.disabled.configure_embedding', {
              defaultValue: 'Configure the embedding provider in the Models tab first.',
            }),
          }
        if (!embedPrivacyAccepted)
          return {
            disabled: true,
            hint: t('feature.disabled.accept_privacy', {
              defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
            }),
          }
        return { disabled: false, hint: undefined }

      case 'image_generation':
        // Gated by the IMAGE slot, not the chat slot — they are separate
        // providers, and the backend's `feature_requirement` checks the
        // same `image::PROVIDER` key.
        if (!imageConnected || imageConfig == null)
          return {
            disabled: true,
            hint: t('feature.disabled.configure_image', {
              defaultValue: 'Configure the image provider in the Models tab first.',
            }),
          }
        if (!imagePrivacyAccepted)
          return {
            disabled: true,
            hint: t('feature.disabled.accept_privacy', {
              defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
            }),
          }
        if (!imageConfig.imageModel)
          return {
            disabled: true,
            hint: t('feature.image_generation.requires_model'),
          }
        return { disabled: false, hint: undefined }

      case 'chat_rag':
        // Reads from BOTH slots at runtime (generation for the chat answer,
        // embedding for retrieval) — require both here too, mirroring the
        // backend's `feature_requirement` (C8 fix).
        if (!genConfigured)
          return {
            disabled: true,
            hint: t('feature.disabled.configure_generation', {
              defaultValue: 'Configure the generation provider in the Models tab first.',
            }),
          }
        if (!genPrivacyAccepted)
          return {
            disabled: true,
            hint: t('feature.disabled.accept_privacy', {
              defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
            }),
          }
        if (!embedConfigured)
          return {
            disabled: true,
            hint: t('feature.disabled.configure_embedding', {
              defaultValue: 'Configure the embedding provider in the Models tab first.',
            }),
          }
        if (!embedPrivacyAccepted)
          return {
            disabled: true,
            hint: t('feature.disabled.accept_privacy', {
              defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
            }),
          }
        return { disabled: false, hint: undefined }

      case 'continue_writing':
        // Persona is a hard precondition — the backend rejects the call with
        // AI_PERSONA_DISABLED — so say that before the generic slot hints.
        if (settings != null && !settings.personaEnabled)
          return {
            disabled: true,
            hint: t('feature.disabled.needs_persona'),
          }
        if (!genConfigured)
          return {
            disabled: true,
            hint: t('feature.disabled.configure_generation', {
              defaultValue: 'Configure the generation provider in the Models tab first.',
            }),
          }
        if (!genPrivacyAccepted)
          return {
            disabled: true,
            hint: t('feature.disabled.accept_privacy', {
              defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
            }),
          }
        return { disabled: false, hint: undefined }

      default:
        // All other features require generation slot
        if (!genConfigured)
          return {
            disabled: true,
            hint: t('feature.disabled.configure_generation', {
              defaultValue: 'Configure the generation provider in the Models tab first.',
            }),
          }
        if (!genPrivacyAccepted)
          return {
            disabled: true,
            hint: t('feature.disabled.accept_privacy', {
              defaultValue: 'Accept the AI privacy notice in Settings → AI first.',
            }),
          }
        return { disabled: false, hint: undefined }
    }
  }

  function makeToggle(feature: AIFeature) {
    const state = genFeatureState(feature)
    return state
  }

  const semanticState = makeToggle('semantic_search')
  const emotionState = makeToggle('emotion_suggestions')
  const titleState = makeToggle('title_suggestions')
  const highlightsState = makeToggle('entry_highlights')
  const goDeeperState = makeToggle('go_deeper')
  const continueWritingState = makeToggle('continue_writing')
  const dailyChatState = makeToggle('daily_chat')
  const chatMemoryState = makeToggle('chat_memory')
  /** Global Memory master preference — the outer switch for chat injection. */
  const memoryMasterOn = !!settings?.userMemoryEnabled
  const imageGenState = makeToggle('image_generation')
  const multiSummaryState = makeToggle('multi_entry_summary')
  const periodicReviewState = makeToggle('periodic_review')
  const tagSuggestionsState = makeToggle('tag_suggestions')
  const themeInsightsState = makeToggle('theme_insights')
  const dashboardInsightsState = makeToggle('dashboard_insights')
  const chatRagState = makeToggle('chat_rag')

  // `needs_provider` outranks everything: with no usable embedding provider on
  // this device the indexer cannot run at all, so `ragStatus` sits at 'idle'
  // and would otherwise render a green "Up to date" — a device that adopted a
  // cloud vault inherits a full embedding index it has no way to extend, and
  // "Up to date" is exactly the wrong thing to tell that user.
  const ragWarning: 'needs_provider' | 'many_pending' | 'needs_consent' | null = !embedConnected
    ? 'needs_provider'
    : ragStatus === 'needs_consent'
      ? 'needs_consent'
      : ragPendingCount >= RAG_PENDING_WARNING_THRESHOLD
        ? 'many_pending'
        : null

  // Idle-with-no-backlog gets a compact badge next to the title instead of
  // the boxed status line below. Idle-with-backlog (ragWarning ===
  // 'many_pending') keeps the box so the warning triangle + label stay
  // visible — a badge here would silently hide an active backlog.
  const showUpToDateBadge = ragStatus === 'idle' && ragWarning == null

  // Overridden locally rather than inside `embeddingStatusLabel` — the
  // idle → "Up to date" mapping there is still correct for BackfillRow, which
  // only renders once a provider exists.
  const ragStatusLabel =
    ragWarning === 'needs_provider'
      ? t('backfill.status_needs_provider')
      : getEmbeddingStatusLabel(ragStatus, ragPendingCount, t, ragDownloadProgress)
  const ragStatusTone =
    ragWarning === 'needs_provider' ? 'text-warning-text' : getEmbeddingStatusToneClass(ragStatus)

  return (
    <div className="space-y-5">
      <FeatureGroup
        title={t('section.features_rag')}
        badge={
          showUpToDateBadge ? (
            <span className="bg-success/15 text-success-text text-2xs shrink-0 rounded-full px-2 py-0.5 font-medium">
              {t('backfill.status_up_to_date')}
            </span>
          ) : undefined
        }
        status={
          !showUpToDateBadge ? (
            <p className={cn('flex items-center gap-1.5 text-xs font-medium', ragStatusTone)}>
              {ragWarning && (
                <Tooltip content={t(`feature.rag_group.warning_${ragWarning}`)}>
                  {/* No colour of its own — inherits the row's status tone, so an
                      error row can't render red text next to an amber icon. */}
                  <AlertTriangle
                    className="size-3.5 shrink-0"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                </Tooltip>
              )}
              {ragStatusLabel}
            </p>
          ) : undefined
        }
      >
        <FeatureToggle
          feature="semantic_search"
          enabled={!!settings?.semanticSearchEnabled}
          disabled={semanticState.disabled}
          hint={semanticState.hint}
          onToggle={(v) => void onToggle('semantic_search', v)}
        >
          <DefaultSearchModeRow disabled={semanticState.disabled} />
        </FeatureToggle>

        <FeatureToggle
          feature="emotion_suggestions"
          enabled={!!settings?.emotionSuggestionsEnabled}
          disabled={emotionState.disabled}
          hint={emotionState.hint}
          onToggle={(v) => void onToggle('emotion_suggestions', v)}
        >
          <div id="settings-anchor-emotion-language">
            <EmotionSuggestionLanguagePicker
              language={(settings?.emotionSuggestionLanguage as EmotionSuggestionLanguage) ?? 'en'}
              disabled={emotionState.disabled}
              onChange={(lang) => {
                void setEmotionLanguage(lang).catch((e) => onError(errMsg(e)))
              }}
            />
          </div>
        </FeatureToggle>

        <FeatureToggle
          feature="chat_rag"
          enabled={!!settings?.chatRagEnabled}
          disabled={chatRagState.disabled}
          hint={chatRagState.hint}
          onToggle={(v) => void onToggle('chat_rag', v)}
        />
      </FeatureGroup>

      <FeatureGroup title={t('section.features_general')}>
        <FeatureToggle
          feature="title_suggestions"
          enabled={!!settings?.titleSuggestionsEnabled}
          disabled={titleState.disabled}
          hint={titleState.hint}
          onToggle={(v) => void onToggle('title_suggestions', v)}
        >
          <FeaturePromptEditor
            feature="title_suggestions"
            value={settings?.titleSuggestionsSystemPrompt ?? ''}
            disabled={titleState.disabled}
            onSaved={() => refresh()}
            onError={onError}
          />
        </FeatureToggle>

        <FeatureToggle
          feature="entry_highlights"
          enabled={!!settings?.entryHighlightsEnabled}
          disabled={highlightsState.disabled}
          hint={highlightsState.hint}
          onToggle={(v) => void onToggle('entry_highlights', v)}
        >
          <FeaturePromptEditor
            feature="entry_highlights"
            value={settings?.entryHighlightsSystemPrompt ?? ''}
            disabled={highlightsState.disabled}
            onSaved={() => refresh()}
            onError={onError}
          />
        </FeatureToggle>

        <FeatureToggle
          feature="go_deeper"
          enabled={!!settings?.goDeeperEnabled}
          disabled={goDeeperState.disabled}
          hint={goDeeperState.hint}
          onToggle={(v) => void onToggle('go_deeper', v)}
        >
          <FeaturePromptEditor
            feature="go_deeper"
            value={settings?.goDeeperSystemPrompt ?? ''}
            disabled={goDeeperState.disabled}
            onSaved={() => refresh()}
            onError={onError}
          />
        </FeatureToggle>

        <FeatureToggle
          feature="continue_writing"
          enabled={!!settings?.continueWritingEnabled}
          disabled={continueWritingState.disabled}
          hint={continueWritingState.hint}
          onToggle={(v) => void onToggle('continue_writing', v)}
        />

        <FeatureToggle
          feature="daily_chat"
          enabled={!!settings?.dailyChatEnabled}
          disabled={dailyChatState.disabled}
          hint={dailyChatState.hint}
          onToggle={(v) => void onToggle('daily_chat', v)}
        >
          <div className="space-y-3">
            <div id="settings-anchor-daily-chat-persona">
              <DailyChatPersonaPicker
                persona={(settings?.dailyChatPersona as DailyChatPersona) ?? 'empathetic'}
                customPersona={settings?.dailyChatCustomPersona ?? ''}
                onChangePersona={(p) => {
                  void setDailyChatPrefs(p, settings?.dailyChatCustomPersona ?? '').catch((e) =>
                    onError(errMsg(e)),
                  )
                }}
                onChangeCustom={(text) => {
                  void setDailyChatPrefs(settings?.dailyChatPersona ?? 'empathetic', text).catch(
                    (e) => onError(errMsg(e)),
                  )
                }}
              />
            </div>
            {/* Memory injection sub-setting. The global Memory master toggle
                is the outer switch — when it is off this row is frozen and
                says so, rather than silently doing nothing. */}
            <SettingsRow
              title={t('daily_chat.use_memory_label')}
              hint={
                memoryMasterOn
                  ? t('daily_chat.use_memory_description')
                  : t('daily_chat.use_memory_needs_master')
              }
              divider={false}
              className="py-2"
            >
              <Toggle
                checked={!!settings?.chatMemoryEnabled}
                onChange={(v) => void onToggle('chat_memory', v)}
                ariaLabel={t('daily_chat.use_memory_label')}
                disabled={chatMemoryState.disabled || !memoryMasterOn}
              />
            </SettingsRow>
            <SettingsRow
              title={t('daily_chat.ai_title_label', {
                defaultValue: 'AI-generated titles',
              })}
              divider={false}
              className="py-2"
            >
              <Toggle
                checked={!!settings?.dailyChatAiTitle}
                onChange={(next) => {
                  void setDailyChatAiTitlePref(next).catch((e) => onError(errMsg(e)))
                }}
                ariaLabel={t('daily_chat.ai_title_label', {
                  defaultValue: 'AI-generated titles',
                })}
              />
            </SettingsRow>
            <SettingsRow
              title={t('daily_chat.show_message_meta.title', {
                defaultValue: 'Show model info on replies',
              })}
              divider={false}
              className="py-2"
            >
              <Toggle
                checked={showMessageMeta}
                onChange={(v) => {
                  void setShowMessageMeta(v).catch((e) => onError(errMsg(e)))
                }}
                ariaLabel={t('daily_chat.show_message_meta.title', {
                  defaultValue: 'Show model info on replies',
                })}
                disabled={showMessageMetaLoading}
              />
            </SettingsRow>
          </div>
        </FeatureToggle>

        {genSupportsImage && (
          <FeatureToggle
            feature="image_generation"
            enabled={!!settings?.imageGenerationEnabled}
            disabled={imageGenState.disabled}
            hint={imageGenState.hint}
            onToggle={(v) => void onToggle('image_generation', v)}
          />
        )}

        <FeatureToggle
          feature="multi_entry_summary"
          enabled={!!settings?.multiEntrySummaryEnabled}
          disabled={multiSummaryState.disabled}
          hint={multiSummaryState.hint}
          onToggle={(v) => void onToggle('multi_entry_summary', v)}
        >
          <FeaturePromptEditor
            feature="multi_entry_summary"
            value={settings?.multiEntrySummarySystemPrompt ?? ''}
            disabled={multiSummaryState.disabled}
            onSaved={() => refresh()}
            onError={onError}
          />
        </FeatureToggle>

        <FeatureToggle
          feature="tag_suggestions"
          enabled={!!settings?.tagSuggestionsEnabled}
          disabled={tagSuggestionsState.disabled}
          hint={tagSuggestionsState.hint}
          onToggle={(v) => void onToggle('tag_suggestions', v)}
        />

        <FeatureToggle
          feature="periodic_review"
          enabled={!!settings?.periodicReviewEnabled}
          disabled={periodicReviewState.disabled}
          hint={periodicReviewState.hint}
          onToggle={(v) => void onToggle('periodic_review', v)}
        />

        <FeatureToggle
          feature="theme_insights"
          enabled={!!settings?.insightsEnabled}
          disabled={themeInsightsState.disabled}
          hint={themeInsightsState.hint}
          onToggle={(v) => void onToggle('theme_insights', v)}
        />

        <FeatureToggle
          feature="dashboard_insights"
          enabled={!!settings?.dashboardInsightsEnabled}
          disabled={dashboardInsightsState.disabled}
          hint={dashboardInsightsState.hint}
          onToggle={(v) => void onToggle('dashboard_insights', v)}
        />
      </FeatureGroup>
    </div>
  )
}

// ─── Subcomponents (kept inline; nothing else uses them) ─────────────────────

/** Small circular "?" affordance. Replaces always-on description
 *  paragraphs: the explanatory text lives in a hover/focus tooltip so the
 *  settings read as a clean list of controls rather than a wall of prose. */
function HelpTip({ content }: { content: string }) {
  return (
    <Tooltip content={content} multiline placement="top">
      <button
        type="button"
        aria-label={content}
        className="text-fg-muted hover:text-fg-secondary inline-flex cursor-help items-center rounded-full outline-none"
      >
        <HelpCircle className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </Tooltip>
  )
}

interface SettingCardProps {
  /** Heading text for this group of settings. */
  title: string
  /** Optional one-line explanation, surfaced via a "?" tooltip next to
   *  the heading instead of an inline paragraph. */
  tip?: string
  /** Optional amber warning icon + tooltip next to the heading (e.g. CLI
   *  latency notice on the Chat model slot). */
  warning?: string
  children: React.ReactNode
}

/** Slot card for Chat / Image / Embedding model pickers — SuperX flat
 *  surface: charcoal fill, strong edge, no elevation shadow. */
function SettingCard({ title, tip, warning, children }: SettingCardProps) {
  return (
    <section className={cn(SETTINGS_SURFACE_CARD, 'space-y-3 p-4')}>
      <div className="flex items-center gap-1.5">
        <h3 className="text-fg text-sm font-semibold">{title}</h3>
        {warning && (
          <Tooltip content={warning} multiline placement="top">
            <button
              type="button"
              aria-label={warning}
              className="text-warning hover:text-warning-text inline-flex cursor-help items-center rounded-full outline-none"
            >
              <AlertTriangle className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {tip && <HelpTip content={tip} />}
      </div>
      {children}
    </section>
  )
}

interface FeatureGroupProps {
  title: string
  /** Optional section description shown under the title in muted text. */
  tip?: string
  badge?: React.ReactNode
  status?: React.ReactNode
  children: React.ReactNode
}

/** Features tab group — section label sits *outside* the surface card
 *  (SuperX: labels above, content in the charcoal box). Optional `tip`
 *  renders as a dimmed description under the title (same pattern as
 *  provider rows), never a "?" tooltip. */
function FeatureGroup({ title, tip, badge, status, children }: FeatureGroupProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-sm font-semibold">{title}</h3>
        {badge}
        {status}
      </div>
      {tip && <p className="text-fg-muted text-xs leading-snug">{tip}</p>}
      <section className={SETTINGS_SURFACE_CARD}>
        <div className="divide-border-default divide-y">{children}</div>
      </section>
    </div>
  )
}

interface ProviderPickerProps {
  value: string
  onChange: (id: string) => void
  /** Only presets whose `capabilities` include this value are shown —
   *  every call site on the Models tab always passes one. */
  capability: ProviderCapability
  /** Every preset's per-preset credential registry row (T1.6) — used
   *  with `providerIsConfigured` to decide which presets are connected. */
  credentials: ProviderCredential[]
  /** Whether each on-device catalog has at least one ready model —
   *  drives connected status for the integrated presets. */
  readyOnDevice: { embed: boolean; llm: boolean }
}

/** Flat, connected-only provider dropdown for the feature tabs.
 *  Only presets the user has connected on the Providers tab appear —
 *  no group headings, no disabled "Needs API key" rows. Connect more
 *  providers from the Providers tab. A stale `value` (slot still points
 *  at a now-disconnected preset) is still listed so the Select can
 *  render the saved selection. */
function ProviderPicker({
  value,
  onChange,
  capability,
  credentials,
  readyOnDevice,
}: ProviderPickerProps) {
  const { t } = useTranslation('ai')
  const addedProviders = useUiStore((s) => s.addedProviders)

  const credentialByPreset = useMemo(() => {
    const map = new Map<string, ProviderCredential>()
    for (const c of credentials) map.set(c.presetId, c)
    return map
  }, [credentials])

  const options = useMemo(
    () =>
      buildConnectedProviderOptions(
        capability,
        credentialByPreset,
        addedProviders,
        readyOnDevice,
        value,
      ),
    [capability, credentialByPreset, addedProviders, readyOnDevice, value],
  )

  return (
    <Select
      className="px-3 py-2.5"
      value={value}
      onChange={onChange}
      options={options}
      aria-label={t('section.provider')}
    />
  )
}

// `FIELD_LABEL_CLASS` / `LabeledInput` / `ApiKeyField` now live in
// `./ApiKeyField.tsx` (T3.2) so `ProvidersTab`'s per-preset rows share the
// exact same implementation instead of drifting from this file's copy.

/** One settings row: provider dropdown and model dropdown side by side,
 *  each taking half the width. Used by the Models tab
 *  so a slot reads as a single "this provider, that model" line instead of
 *  two labelled sections. */
function ProviderModelRow({
  provider,
  model,
}: {
  provider: React.ReactNode
  model: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-2">{provider}</div>
      <div className="min-w-0 flex-3">{model}</div>
    </div>
  )
}

interface ModelFieldProps {
  /** Always required — it feeds `aria-label` even when the visible label
   *  column is suppressed via `hideLabel`. */
  label: string
  /** Drop the fixed-width label column so the control fills its container.
   *  Used by `ProviderModelRow`, where the section heading already names
   *  the slot. */
  hideLabel?: boolean
  value: string
  onChange: (v: string) => void
  /** Curated suggestions for this preset/role. */
  suggestions?: ModelSuggestion[]
  /** Locally-installed Ollama models (only populated when the active
   *  preset is Ollama). Rendered above curated suggestions. */
  installed?: ComboBoxOption[]
  /** When true, show a hint that the local Ollama server isn't
   *  reachable so the user knows why the "Installed" group is empty. */
  ollamaUnreachable?: boolean
}

function ModelField({
  label,
  hideLabel = false,
  value,
  onChange,
  suggestions,
  installed,
  ollamaUnreachable,
}: ModelFieldProps) {
  const { t } = useTranslation('ai')

  // Single flat list: installed models first, then curated suggestions not
  // already in that list. See `buildModelOptions` for the badge rules —
  // notably, the default suggestion still says "Recommended" even when
  // it's also installed (combined into one badge), rather than losing the
  // signal to dedup.
  const options = useMemo<ComboBoxOption[]>(
    () =>
      buildModelOptions(installed, suggestions, {
        installed: t('models.badge_installed'),
        recommended: t('models.badge_recommended'),
      }),
    [installed, suggestions, t],
  )

  const control = (
    <div className="min-w-0 flex-1">
      {options.length > 0 ? (
        <ComboBox
          value={value}
          onChange={onChange}
          options={options}
          className="px-3 py-2.5"
          aria-label={label}
        />
      ) : (
        <TextInput value={value} onChange={onChange} className="font-mono" aria-label={label} />
      )}
      {/* Same empty-state brown the Memory tab uses for this notice — the
          provider is reachable-but-absent, not an error. Kept inside the
          control column here (unlike Memory) because this field sits in a
          wide label/control grid with room to wrap. */}
      {ollamaUnreachable && (
        <span className="text-empty-text mt-1 block text-xs">{t('models.ollama_unreachable')}</span>
      )}
    </div>
  )

  if (hideLabel) return control

  return (
    <label className="flex items-center gap-3">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      {control}
    </label>
  )
}

interface OnDeviceModelFieldProps {
  /** Always required — feeds `aria-label` even when `hideLabel` is set. */
  label: string
  /** Drop the fixed-width label column (see `ModelFieldProps.hideLabel`). */
  hideLabel?: boolean
  value: string
  onChange: (v: string) => void
  /** Catalog entries filtered to `status === 'ready'` — i.e. actually
   *  downloaded and usable, never a preset suggestion string (T4.2). */
  readyModels: { id: string; label: string }[]
  /** Preset to pre-expand on the Providers tab when the user clicks the
   *  empty-state link — `'on-device'` for the embed slot, `'on-device-llm'`
   *  for the chat slot. */
  providersPresetId: string
}

/** Model picker for `on-device` / `on-device-llm` — unlike `ModelField`
 *  (free text + curated suggestions), this only ever offers models that
 *  are really on disk. When nothing is downloaded yet, it renders a link
 *  to the Providers tab instead of a dropdown, using the same
 *  `aiTab` + `pendingOpenPresetId` cross-tab handoff `ProviderPicker`
 *  already established (T4.1/T3.1) — no second mechanism. */
function OnDeviceModelField({
  label,
  hideLabel = false,
  value,
  onChange,
  readyModels,
  providersPresetId,
}: OnDeviceModelFieldProps) {
  const { t } = useTranslation('ai')
  const setPendingOpenPresetId = useUiStore((s) => s.setPendingOpenPresetId)

  if (readyModels.length === 0) {
    const empty = (
      <div className="min-w-0 flex-1 text-sm">
        <span className="text-fg-muted">{t('field.on_device_no_models')}</span>{' '}
        <button
          type="button"
          className="text-accent hover:text-accent-hover underline"
          onClick={() => {
            useTabStore.getState().updateActiveTab({ aiTab: 'providers' })
            setPendingOpenPresetId(providersPresetId)
          }}
        >
          {t('field.on_device_no_models_link')}
        </button>
      </div>
    )
    if (hideLabel) return empty
    return (
      <div className="flex items-center gap-3">
        <span className={FIELD_LABEL_CLASS}>{label}</span>
        {empty}
      </div>
    )
  }

  const options: SelectOption[] = readyModels.map((m) => ({ value: m.id, label: m.label }))
  const control = (
    <div className="min-w-0 flex-1">
      <Select value={value} onChange={onChange} options={options} aria-label={label} />
    </div>
  )

  if (hideLabel) return control

  return (
    <label className="flex items-center gap-3">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      {control}
    </label>
  )
}

interface GeneralTabProps {
  responseLanguage: string
  setResponseLanguage: (language: string) => Promise<void>
  onError: (msg: string | null) => void
}

function GeneralTab({ responseLanguage, setResponseLanguage, onError }: GeneralTabProps) {
  return (
    <section id="settings-anchor-response-language" className={cn(SETTINGS_SURFACE_CARD, 'p-4')}>
      <ResponseLanguagePicker
        value={responseLanguage}
        onChange={(next) => {
          void setResponseLanguage(next).catch((e) => onError(errMsg(e)))
        }}
      />
    </section>
  )
}

interface FeatureToggleProps {
  feature: AIFeature
  enabled: boolean
  disabled: boolean
  /** Optional note under the row — typically *why* the toggle is disabled. */
  hint?: string
  onToggle: (v: boolean) => void
  /** Sub-settings. When present the row becomes an accordion (collapsed by
   *  default). Features with no children never expand. */
  children?: React.ReactNode
}

/** Feature row: title + dimmed description + on/off toggle.
 *
 *  Layout mirrors Providers tab `ProviderRow`: name on the first line,
 *  short description under it in `text-fg-muted` (no "?" tooltip).
 *
 *  - **With sub-settings** → accordion (+/−). Expanded body is sub-settings
 *    only (description stays in the header).
 *  - **Without** → flat row with a static minus icon (same style as expanded
 *    accordion); never expands.
 *
 *  High-usage cost notes append to the description when relevant. */
function FeatureToggle({
  feature,
  enabled,
  disabled,
  hint,
  onToggle,
  children,
}: FeatureToggleProps) {
  const { t } = useTranslation('ai')
  const [open, setOpen] = useState(false)
  const hasSubSettings = children != null
  const title = t(`feature.${feature}.title`)
  const description = t(`feature.${feature}.description`)
  const fullDescription = isHighUsageRisk(feature)
    ? `${description} ${t(`usage_warning.${feature}`, {
        defaultValue: getFeatureUsageMeta(feature).callPattern,
      })}`
    : description
  const panelId = `ai-feature-panel-${feature}`
  const headerId = `ai-feature-header-${feature}`

  const accordionIconClass = 'text-fg-muted mt-0.5 size-4 shrink-0'

  const titleAndDescription = (
    <span className="min-w-0 flex-1">
      <span className="text-fg block text-sm font-medium">{title}</span>
      {fullDescription !== '' && (
        <span className="text-fg-muted mt-0.5 block text-xs leading-snug">{fullDescription}</span>
      )}
    </span>
  )

  // Dim only when the toggle is genuinely inert. A blocked-but-ON feature keeps
  // its toggle live (see `<Toggle>` below), so dimming the row there would
  // advertise less affordance than the control actually has.
  return (
    <div className={cn('px-4', disabled && !enabled && 'opacity-60')}>
      <div className="flex items-center gap-3 py-3">
        {hasSubSettings ? (
          <button
            type="button"
            id={headerId}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              'hover:text-fg text-fg flex min-w-0 flex-1 items-start gap-2 text-left',
              'rounded-sm outline-none',
            )}
          >
            {open ? (
              <Minus className={accordionIconClass} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Plus className={accordionIconClass} strokeWidth={1.75} aria-hidden="true" />
            )}
            {titleAndDescription}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Minus className={accordionIconClass} strokeWidth={1.75} aria-hidden="true" />
            {titleAndDescription}
          </div>
        )}
        {/* `disabled` blocks a native <button> in BOTH directions, so an
            already-ON feature would become impossible to turn off — the
            feature flags DO sync, so a joined device can inherit
            `enabled: true` for a feature it cannot run. Never trap the user
            in an ON state: only the OFF→ON transition is gated. */}
        <Toggle
          checked={enabled}
          onChange={onToggle}
          ariaLabel={title}
          disabled={disabled && !enabled}
        />
      </div>

      {/* Always rendered, including for accordion features. Their copy of the
          hint (below) lives inside the collapsible panel, which is `inert` +
          `aria-hidden` while closed — so a blocked feature whose accordion the
          user never opens showed a live-but-unusable toggle with no stated
          reason. */}
      {/* Indent to match title/description (icon size-4 + gap-2 = pl-6), not
          the accordion +/- icon. */}
      {hint && <p className="text-warning -mt-1.5 pb-2.5 pl-6 text-xs leading-snug">{hint}</p>}

      {/* Height-animate via grid-rows (0fr → 1fr). Content stays mounted so
          collapse is smooth; `inert` + `aria-hidden` keep the closed panel
          out of tab/AT order. Reduced motion → no transition. */}
      {hasSubSettings && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headerId}
          aria-hidden={!open}
          inert={!open}
          className={cn(
            'grid transition-[grid-template-rows] duration-(--motion-duration-base) ease-(--motion-ease-out-expo)',
            'motion-reduce:transition-none',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="min-h-0 overflow-hidden pl-5">
            <div
              className={cn(
                'border-border-default bg-app/35 mb-3 space-y-3 rounded-xl border px-4 py-4',
                'transition-opacity duration-(--motion-duration-base) ease-(--motion-ease-out-expo)',
                'motion-reduce:transition-none',
                open ? 'opacity-100' : 'opacity-0',
              )}
            >
              {enabled ? (
                children
              ) : (
                <p className="text-fg-muted text-2xs leading-snug">
                  {t('feature.accordion.enable_to_configure', {
                    defaultValue: 'Turn on to configure.',
                  })}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Inline row beneath the Semantic Search toggle: prefer meaning search by
 * default (on) vs keyword (off). Label is self-explanatory — no hint.
 */
function DefaultSearchModeRow({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('ai')
  const { mode, setMode } = useDefaultSearchMode()
  return (
    <SettingsRow
      title={t('search.default_mode_title')}
      divider={false}
      className={cn('py-1.5', disabled && 'opacity-60')}
    >
      <Toggle
        checked={mode === 'meaning'}
        onChange={(next) => void setMode(next ? 'meaning' : 'keyword')}
        ariaLabel={t('search.default_mode_aria')}
        disabled={disabled}
      />
    </SettingsRow>
  )
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** First preset id capable of the given capability from the local group,
 *  falling back to the first capable preset overall. */
function getDefaultPresetIdForCapability(cap: ProviderCapability): string {
  const capable = getPresetsByCapability(cap)
  // Image is the exception to the local-first default: the local presets
  // are generic OpenAI-compatible endpoints that advertise `image` but ship
  // no image model, so defaulting there lands the user on an empty model
  // dropdown. Prefer a preset that actually names a default image model.
  if (cap === 'image') {
    const withModel = capable.find((p) => p.imageModel != null && p.imageModel !== '')
    if (withModel) return withModel.id
  }
  return (
    capable.find((p) => p.group === 'local')?.id ?? capable[0]?.id ?? PROVIDER_PRESETS[0]?.id ?? ''
  )
}
