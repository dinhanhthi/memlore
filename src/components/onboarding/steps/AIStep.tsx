import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertTriangle,
  Brackets,
  CheckCircle2,
  ExternalLink,
  HardDrive,
  MemoryStick,
  XCircle,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../../common/Modal'
import { Tooltip } from '../../common/Tooltip'
import { useAIProviderConfig } from '../../../hooks/useAIProviderConfig'
import {
  TermsNotAcceptedError,
  useOnDeviceLlmModels,
  type OnDeviceLlmCatalogEntry,
} from '../../../hooks/useOnDeviceLlmModels'
import {
  ON_DEVICE_MODEL_CATALOG,
  useOnDeviceModels,
  type OnDeviceModelCatalogEntry,
} from '../../../hooks/useOnDeviceModels'
import type {
  AIEmbedProviderConfigInput,
  AIFeature,
  AIGenProviderConfigInput,
  AIImageProviderConfigInput,
  ProviderPreset,
} from '../../../types/ai'
import {
  EMBEDDING_DEPENDENT_FEATURES,
  getPresetsByCapability,
  getPreset,
  providerIsOnDevice,
  providerUsesSubprocess,
} from '../../../types/ai'
import { cn } from '../../../lib/cn'
import { buildModelOptions } from '../../../lib/modelOptions'
import {
  isFeatureEnabled,
  isFeatureUnavailable,
  masterToggleTargets,
  ONBOARDING_FEATURES,
  parsePartialFeatureUpdateError,
  shouldKickOnDeviceDownload,
} from '../../../lib/onboardingAiFeatures'
import {
  adoptedAiSetupFingerprint,
  adoptSetupStages,
  providerEndpointIsEditable,
  seedAdoptSlotDraft,
} from '../../../lib/adoptedAiSetup'
import type { AiModelSlotId } from '../../../lib/aiProviderStatus'
import { AIPrivacyNoticePanel } from '../../settings/AIPrivacyNoticePanel'
import { Toggle } from '../../settings/Toggle'
import { Button } from '../../common/Button'
import { ComboBox } from '../../common/ComboBox'
import { Select, type SelectGroup, type SelectOption } from '../../common/Select'
import { TextInput } from '../../common/TextInput'

// Chat-capable presets for the generation slot. `on-device` is embed-only
// so it's excluded automatically by the capability filter.
const GENERATION_PRESETS = getPresetsByCapability('chat')

/** Classifies a chat-capable preset into the same disclosure taxonomy the
 *  backend uses for `EndpointClass` when the slot is actually saved
 *  (`classify_provider_disclosure` in `ai_provider.rs`): subprocess-backed
 *  CLIs are `'subscription'` — checked FIRST, before endpoint locality —
 *  because `claude-cli`/`codex-cli` forward the prompt to Anthropic/OpenAI
 *  under the user's plan even though they spawn a local binary. Everything
 *  else follows the preset's `group`:
 *  - `'integrated'` (e.g. `on-device-llm`) → own UI group
 *  - `'local'` → local HTTP servers
 *  - everything else (`'hosted'`, including `custom`) → remote/network
 *  `'on-device'` never reaches here — it's embed-only and excluded by the
 *  capability filter above. */
function classifyGenGroup(
  preset: ProviderPreset,
): 'local' | 'integrated' | 'subscription' | 'remote' {
  if (providerUsesSubprocess(preset.id)) return 'subscription'
  if (preset.group === 'integrated') return 'integrated'
  return preset.group === 'local' ? 'local' : 'remote'
}

const LOCAL_GEN_PRESETS = GENERATION_PRESETS.filter((p) => classifyGenGroup(p) === 'local')
const INTEGRATED_GEN_PRESETS = GENERATION_PRESETS.filter(
  (p) => classifyGenGroup(p) === 'integrated',
)
const SUBSCRIPTION_GEN_PRESETS = GENERATION_PRESETS.filter(
  (p) => classifyGenGroup(p) === 'subscription',
)
const REMOTE_GEN_PRESETS = GENERATION_PRESETS.filter((p) => classifyGenGroup(p) === 'remote')

// Embed-capable presets for the embedding slot. Includes `on-device`
// (Integrated embedding models): catalog model Select + background download
// on Continue, same pattern as generation's `on-device-llm`.
const EMBEDDING_PRESETS = getPresetsByCapability('embed')
const LOCAL_EMBED_PRESETS = EMBEDDING_PRESETS.filter((p) => p.group === 'local')
const INTEGRATED_EMBED_PRESETS = EMBEDDING_PRESETS.filter((p) => p.group === 'integrated')
const HOSTED_EMBED_PRESETS = EMBEDDING_PRESETS.filter((p) => p.group === 'hosted')

const IMAGE_PRESETS = getPresetsByCapability('image')
const LOCAL_IMAGE_PRESETS = IMAGE_PRESETS.filter((p) => classifyGenGroup(p) === 'local')
const INTEGRATED_IMAGE_PRESETS = IMAGE_PRESETS.filter((p) => classifyGenGroup(p) === 'integrated')
const SUBSCRIPTION_IMAGE_PRESETS = IMAGE_PRESETS.filter(
  (p) => classifyGenGroup(p) === 'subscription',
)
const REMOTE_IMAGE_PRESETS = IMAGE_PRESETS.filter((p) => classifyGenGroup(p) === 'remote')

// Features offered during onboarding live in `ONBOARDING_FEATURES`
// (`lib/onboardingAiFeatures.ts`) — every top-level AIFeature is shown,
// never silently hidden, plus `chat_memory` (fail-closed default OFF).
// `chat_rag` and `user_memory` stay excluded. `image_generation` is always
// rendered disabled here (needs image model; this flow doesn't collect one).

/** Compact specs row under the onboarding integrated-model Select. */
function ModelSpecRow({
  items,
}: {
  items: { icon: typeof HardDrive; label: string; value: string }[]
}) {
  return (
    <div className="text-fg-secondary mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {items.map((item) => {
        const Icon = item.icon
        return (
          <span key={item.label} className="inline-flex items-center gap-1 leading-none">
            <Icon className="text-fg-muted size-3.5 shrink-0" aria-hidden="true" />
            <span className="text-fg-muted">{item.label}:</span>
            <span>{item.value}</span>
          </span>
        )
      })}
    </div>
  )
}

type TestState =
  | { kind: 'running' }
  | { kind: 'ok'; latencyMs: number; dim: number | null }
  | { kind: 'error'; message: string }
  | null

export type Stage = 'enable' | 'provider' | 'image' | 'embedding' | 'privacy' | 'features'

// Order Back walks backward through — see `handleBack` below.
const STAGE_ORDER: readonly Stage[] = ['enable', 'provider', 'embedding', 'features']

interface AIStepProps {
  /** Called once the user is done with AI setup — either they answered "No"
   *  at the first question, or they reached the end of the feature-flags
   *  sub-stage. The wizard shell wires this to its own `next()`, which is
   *  the only way to reach the terminal `done` step (see Phase 4). */
  onComplete: () => void
  /** Called when Back is pressed at the first sub-stage (`enable`) — there
   *  is nowhere earlier to go internally, so this hands off to the wizard
   *  shell's own `back()`, leaving the AI step entirely. The shell
   *  suppresses its own footer Back button for this step (see
   *  `OnboardingWizard.tsx`) so `AIStep` owns the single visible Back
   *  affordance at every sub-stage. */
  onExitStep: () => void
  /** Reports whether the flow has moved past the first `enable` sub-stage.
   *  The shell uses this to append "- Set up AI" to the step indicator only
   *  once the user is inside the deeper sub-stages — on `enable` itself the
   *  screen already shows a big "Set up AI" title, so the indicator stays a
   *  plain "Step 4 of 4" there to avoid repeating it. */
  onPastIntroChange?: (pastIntro: boolean) => void
  /** Sub-stage to open on first mount (defaults to `enable`). Only used by
   *  the web preview harness to deep-link straight to a given sub-stage —
   *  the real wizard always enters at `enable`. */
  initialStage?: Stage
  /** `adopt` is the new-device flow: skip enable/features, prefill synced
   *  provider+model, collect credentials for `adoptSlots`. */
  mode?: 'onboarding' | 'adopt'
  /** Slots that still need a credential on this device. Ignored unless
   *  `mode === 'adopt'`. */
  adoptSlots?: readonly AiModelSlotId[]
  /** Adopt-mode: dismiss the whole prompt. Rendered on the same row as
   *  Back / Test / Continue so it is not a second modal footer. */
  onCancel?: () => void
  /** `modal` lifts the action row into `Modal.Footer` (adopt wizard).
   *  `inline` keeps buttons under the form (onboarding page). */
  chrome?: 'inline' | 'modal'
}

function Field({
  label,
  warning,
  children,
}: {
  label: string
  /** Optional amber warning icon + tooltip next to the label. */
  warning?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5 text-left">
      <span className="text-fg flex items-center gap-1.5 text-sm font-medium">
        {label}
        {warning && (
          <Tooltip content={warning} multiline placement="top">
            <button
              type="button"
              aria-label={warning}
              className="text-warning hover:text-warning-text inline-flex cursor-help items-center rounded-full outline-none"
              // Keep the tooltip trigger out of the label's click-to-focus
              // path so hovering the warning doesn't focus the control.
              onClick={(e) => e.preventDefault()}
            >
              <AlertTriangle className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </span>
      {children}
    </label>
  )
}

function ActionBar({
  chrome,
  children,
  className,
}: {
  chrome: 'inline' | 'modal'
  children: ReactNode
  className?: string
}) {
  if (chrome === 'modal') {
    return <Modal.Footer className={cn('justify-between', className)}>{children}</Modal.Footer>
  }
  return (
    <div className={cn('mt-8 flex items-center justify-between gap-2', className)}>{children}</div>
  )
}

/**
 * `AIStep` — progressive-disclosure AI setup for onboarding.
 *
 * Deliberately NOT `AISettingsPanel`'s dense multi-tab layout: this walks
 * one question at a time (enable? → provider → provider-conditional fields
 * → embedding, optional → feature flags), only reusing the persistence
 * hooks/commands. `AIPrivacyNoticePanel` is reused as-is for the privacy
 * notice — `useAIProviderConfig().saveGeneration()` / `saveEmbedding()`
 * report `requiresPrivacyConsent` (see `SetProviderResult`, `src/types/ai.ts`)
 * right after a save promotes a slot to a class that hasn't been accepted
 * yet; that backend-driven flag (not a client-side guess from the preset's
 * `group`) decides whether the notice pops.
 *
 * Drives its own internal navigation (see each sub-stage's own "Continue" /
 * "Skip" / "Finish" buttons) and calls `onComplete` when finished — the
 * wizard shell suppresses its footer Next/Skip for this step and relies on
 * `onComplete` to advance. The shell also suppresses its own footer Back
 * button for this step: `AIStep` renders a single internal Back button
 * (`handleBack`) that walks `STAGE_ORDER` backward one sub-stage at a time,
 * and calls `onExitStep` (wired to the shell's `back()`) only once it's
 * already at the first sub-stage (`enable`) — see `AIStepProps.onExitStep`.
 */
export function AIStep({
  onComplete,
  onExitStep,
  onPastIntroChange,
  initialStage = 'enable',
  mode = 'onboarding',
  adoptSlots = [],
  onCancel,
  chrome = 'inline',
}: AIStepProps) {
  const { t } = useTranslation(['auth', 'ai'])
  const isAdopt = mode === 'adopt'
  const adoptStages = adoptSetupStages(adoptSlots)
  const {
    settings,
    providers,
    credentials,
    credentialsLoaded,
    saveGeneration,
    saveImage,
    saveEmbedding,
    testGeneration,
    testEmbedding,
    saveCredential,
    testCredential,
    acceptPrivacy,
    setFeature,
    setFeatures,
  } = useAIProviderConfig()
  const stageOrder: readonly Stage[] =
    isAdopt && settings?.privacyAcceptedAt == null
      ? [...adoptStages, 'privacy']
      : isAdopt
        ? adoptStages
        : STAGE_ORDER

  // Integrated (on-device) catalogs — always mounted so Continue can kick a
  // background download that keeps running after this step unmounts. Footer
  // chips re-hydrate and show progress once the main shell mounts.
  const {
    catalog: llmCatalog,
    states: llmStates,
    download: downloadLlmModel,
    termsAccepted: llmTermsAccepted,
    acceptTerms: acceptLlmTerms,
  } = useOnDeviceLlmModels()
  const { states: embedOnDeviceStates, download: downloadEmbedModel } = useOnDeviceModels(
    settings?.embeddingModel ?? null,
  )

  const [stage, setStage] = useState<Stage>(() =>
    isAdopt ? (adoptStages[0] ?? 'provider') : initialStage,
  )

  // Tell the shell when we've left the `enable` intro so it can toggle the
  // "- Set up AI" suffix on the step indicator (see `onPastIntroChange`).
  useEffect(() => {
    onPastIntroChange?.(isAdopt || stage !== 'enable')
  }, [stage, onPastIntroChange, isAdopt])

  // ── Generation slot draft ──────────────────────────────────────────────
  const [genPresetId, setGenPresetId] = useState<string | null>(null)
  const [genEndpoint, setGenEndpoint] = useState('')
  const [genApiKey, setGenApiKey] = useState('')
  const [genChatModel, setGenChatModel] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [genTest, setGenTest] = useState<TestState>(null)

  // ── On-device LLM Terms-of-Use modal ───────────────────────────────────
  // Second Gemma download entry point (besides OnDeviceLlmModelPicker): the
  // backend rejects a download with `terms_not_accepted` until the user
  // accepts. Mirror the picker's ToU modal so the wizard's background kick
  // isn't silently swallowed.
  const [llmTermsModalEntry, setLlmTermsModalEntry] = useState<OnDeviceLlmCatalogEntry | null>(null)
  const [acceptingLlmTerms, setAcceptingLlmTerms] = useState(false)

  // ── Embedding slot draft ───────────────────────────────────────────────
  const [embedExpanded, setEmbedExpanded] = useState(
    () => isAdopt && adoptStages.includes('embedding'),
  )

  // ── Image slot draft (adopt flow only) ────────────────────────────────
  const [imagePresetId, setImagePresetId] = useState<string | null>(null)
  const [imageEndpoint, setImageEndpoint] = useState('')
  const [imageApiKey, setImageApiKey] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageTest, setImageTest] = useState<TestState>(null)
  // Session-only flag: flips true right after `saveEmbedding` succeeds in
  // *this* mount. Combined below with `settings.embeddingModel` so a user
  // who configured embedding, left via the shell Back (remounting AIStep
  // at `enable`), and skipped it on re-entry still sees the dependent
  // features (semantic search, emotion suggestions) as available —
  // their on-disk config wasn't lost, only this component's local state was.
  const [embeddingConfiguredThisSession, setEmbeddingConfiguredThisSession] = useState(false)
  const embeddingConfigured = settings?.embeddingModel != null || embeddingConfiguredThisSession
  const [embedPresetId, setEmbedPresetId] = useState<string | null>(null)
  const [embedEndpoint, setEmbedEndpoint] = useState('')
  const [embedApiKey, setEmbedApiKey] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [embedBusy, setEmbedBusy] = useState(false)
  const [embedError, setEmbedError] = useState<string | null>(null)
  const [embedTest, setEmbedTest] = useState<TestState>(null)

  // ── Privacy consent overlay ─────────────────────────────────────────────
  const [privacyPromptFor, setPrivacyPromptFor] = useState<
    'generation' | 'image' | 'embedding' | null
  >(null)

  // ── Feature flags ────────────────────────────────────────────────────────
  const [featureError, setFeatureError] = useState<string | null>(null)
  const [featureBusy, setFeatureBusy] = useState(false)
  const toggleableFeatures = useMemo(
    () => ONBOARDING_FEATURES.filter((f) => !isFeatureUnavailable(f, embeddingConfigured)),
    [embeddingConfigured],
  )
  const allFeaturesEnabled =
    toggleableFeatures.length > 0 && toggleableFeatures.every((f) => isFeatureEnabled(settings, f))

  function describeError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e)
    if (raw.includes('AI_PRIVACY_NOT_ACCEPTED')) return t('ai:error.AI_PRIVACY_NOT_ACCEPTED')
    return raw
  }

  function hasStoredApiKey(presetId: string | null): boolean {
    if (!presetId) return false
    return credentials.find((row) => row.presetId === presetId)?.hasApiKey === true
  }

  const genPreset = genPresetId ? getPreset(genPresetId) : undefined
  const isGenOnDevice = genPreset != null && providerIsOnDevice(genPreset.id)
  // Hosted / fixed-URL presets must not render the endpoint field — it
  // cannot be edited. Only custom / other-local stay visible.
  const showGenEndpoint = genPreset != null && providerEndpointIsEditable(genPreset.id)
  // T2.6 cutover: ONLY presets with an HTTP surface (not CLI subprocess,
  // not on-device — `on-device-llm` is chat-capable and reaches this stage,
  // see `providerIsOnDevice`) write/probe through the per-preset credential
  // registry.
  const genHasCredentialSurface =
    genPreset != null && !providerUsesSubprocess(genPreset.id) && !providerIsOnDevice(genPreset.id)
  // Endpoint is user-editable only for the two open-ended presets — every
  // other provider (hosted cloud APIs and the fixed-URL local servers) has a
  // known endpoint that must not be changed. Mirrors Settings' `readOnly`
  // rule in `AISettingsPanel` (`preset.id !== 'custom' && !== 'other-local'`).
  const genEndpointEditable = genPreset?.id === 'custom' || genPreset?.id === 'other-local'
  const showGenApiKey = genPreset?.requiresApiKey ?? false

  // Curated chat-model suggestions for the current preset — same flat list
  // with Installed/Recommended badges as Settings' `ModelField`. ComboBox is
  // free-text, so custom model ids are typed directly (no "Custom…" sentinel).
  // Presets without suggestions fall back to a plain TextInput below.
  const genModelOptions = useMemo(
    () =>
      buildModelOptions(undefined, genPreset?.chatModelSuggestions, {
        installed: t('ai:models.badge_installed'),
        recommended: t('ai:models.badge_recommended'),
      }),
    [genPreset, t],
  )
  const canSubmitGen =
    genChatModel.trim().length > 0 &&
    (!showGenApiKey || genApiKey.trim().length > 0 || hasStoredApiKey(genPresetId))

  // Catalog options for Integrated chat models (`on-device-llm`).
  const onDeviceLlmModelOptions = useMemo<SelectOption[]>(() => {
    return llmCatalog.map((entry) => {
      const modelKey = `on_device_llm.models.${entry.id}`
      const displayName = t(`ai:${modelKey}.display_name`, {
        defaultValue: entry.display_name,
      })
      const whenToChoose = t(`ai:${modelKey}.when_to_choose`, {
        defaultValue: entry.when_to_choose,
      })
      const sizeGb = (entry.download_size_bytes / 1e9).toFixed(1)
      const shortDesc = entry.recommended
        ? t('ai:on_device_llm.recommended_badge', { defaultValue: 'Recommended' }) +
          ` · ${sizeGb} GB · ${entry.min_ram_gb} GB RAM`
        : `${sizeGb} GB · ${entry.min_ram_gb} GB RAM · ${whenToChoose}`
      return {
        value: entry.id,
        label: displayName,
        description: shortDesc,
      }
    })
  }, [llmCatalog, t])

  const selectedLlmEntry: OnDeviceLlmCatalogEntry | undefined = llmCatalog.find(
    (e) => e.id === genChatModel,
  )

  // Grouped options for the provider dropdown, mirroring Settings'
  // `ProviderSelect` but using this flow's disclosure taxonomy
  // (local / integrated / subscription / hosted). Empty groups are dropped.
  const genProviderGroups = useMemo<SelectGroup[]>(
    () =>
      [
        {
          key: 'local',
          label: t('ai:group.local'),
          options: LOCAL_GEN_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'integrated',
          label: t('ai:group.integrated'),
          options: INTEGRATED_GEN_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'subscription',
          label: t('ai:group.subscription'),
          options: SUBSCRIPTION_GEN_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'hosted',
          label: t('ai:group.hosted'),
          options: REMOTE_GEN_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
      ].filter((g) => g.options.length > 0),
    [t],
  )

  // Grouped options for the embedding provider dropdown: local / integrated
  // (on-device fastembed) / hosted. Empty groups are dropped.
  const embedProviderGroups = useMemo<SelectGroup[]>(
    () =>
      [
        {
          key: 'local',
          label: t('ai:group.local'),
          options: LOCAL_EMBED_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'integrated',
          label: t('ai:group.integrated'),
          options: INTEGRATED_EMBED_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'hosted',
          label: t('ai:group.hosted'),
          options: HOSTED_EMBED_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
      ].filter((g) => g.options.length > 0),
    [t],
  )

  const embedPreset = embedPresetId ? getPreset(embedPresetId) : undefined
  const isEmbedOnDevice = embedPreset != null && providerIsOnDevice(embedPreset.id)
  const showEmbedEndpoint = embedPreset != null && providerEndpointIsEditable(embedPreset.id)
  // Same rule as `genEndpointEditable` above — editable only for the two
  // open-ended presets.
  const embedEndpointEditable = embedPreset?.id === 'custom' || embedPreset?.id === 'other-local'
  const showEmbedApiKey = embedPreset?.requiresApiKey ?? false
  // T2.6 cutover — see `genHasCredentialSurface`.
  const embedHasCredentialSurface =
    embedPreset != null &&
    !providerUsesSubprocess(embedPreset.id) &&
    !providerIsOnDevice(embedPreset.id)

  // Catalog options for Integrated embedding models (`on-device`).
  const onDeviceEmbedModelOptions = useMemo<SelectOption[]>(() => {
    return ON_DEVICE_MODEL_CATALOG.map((entry) => {
      const modelKey = `on_device_models.models.${entry.id}`
      const displayName = t(`ai:${modelKey}.display_name`, {
        defaultValue: entry.displayName,
      })
      const whenToChoose = t(`ai:${modelKey}.when_to_choose`, {
        defaultValue: entry.whenToChoose,
      })
      const size = t(`ai:${modelKey}.download_size`, { defaultValue: entry.downloadSize })
      const ram = t(`ai:${modelKey}.approx_ram`, { defaultValue: entry.approxRam })
      const shortDesc = entry.recommended
        ? t('ai:on_device_models.recommended_badge', { defaultValue: 'Recommended' }) +
          ` · ${size} · ${ram}`
        : `${size} · ${ram} · ${whenToChoose}`
      return {
        value: entry.id,
        label: displayName,
        description: shortDesc,
      }
    })
  }, [t])

  const selectedEmbedOnDeviceEntry: OnDeviceModelCatalogEntry | undefined =
    ON_DEVICE_MODEL_CATALOG.find((e) => e.id === embedModel)

  // Curated embedding-model suggestions — same flat+badge treatment as
  // `genModelOptions` above. Cloud providers ship suggestions; presets
  // without them fall back to a plain TextInput below. Not used for on-device.
  const embedModelOptions = useMemo(
    () =>
      buildModelOptions(undefined, embedPreset?.embeddingModelSuggestions, {
        installed: t('ai:models.badge_installed'),
        recommended: t('ai:models.badge_recommended'),
      }),
    [embedPreset, t],
  )

  const canSubmitEmbed =
    embedModel.trim().length > 0 &&
    (!showEmbedApiKey || embedApiKey.trim().length > 0 || hasStoredApiKey(embedPresetId))

  const imageProviderGroups = useMemo<SelectGroup[]>(
    () =>
      [
        {
          key: 'local',
          label: t('ai:group.local'),
          options: LOCAL_IMAGE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'integrated',
          label: t('ai:group.integrated'),
          options: INTEGRATED_IMAGE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'subscription',
          label: t('ai:group.subscription'),
          options: SUBSCRIPTION_IMAGE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
        {
          key: 'hosted',
          label: t('ai:group.hosted'),
          options: REMOTE_IMAGE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        },
      ].filter((g) => g.options.length > 0),
    [t],
  )
  const imagePreset = imagePresetId ? getPreset(imagePresetId) : undefined
  const showImageEndpoint = imagePreset != null && providerEndpointIsEditable(imagePreset.id)
  const imageEndpointEditable = imagePreset?.id === 'custom' || imagePreset?.id === 'other-local'
  const showImageApiKey = imagePreset?.requiresApiKey ?? false
  const imageHasCredentialSurface =
    imagePreset != null &&
    !providerUsesSubprocess(imagePreset.id) &&
    !providerIsOnDevice(imagePreset.id)
  const imageModelOptions = useMemo(
    () =>
      buildModelOptions(undefined, imagePreset?.imageModelSuggestions, {
        installed: t('ai:models.badge_installed'),
        recommended: t('ai:models.badge_recommended'),
      }),
    [imagePreset, t],
  )
  const canSubmitImage =
    imageModel.trim().length > 0 &&
    (!showImageApiKey || imageApiKey.trim().length > 0 || hasStoredApiKey(imagePresetId))

  // T2.6 cutover: `AIGenProviderConfigInput` / `AIEmbedProviderConfigInput`
  // no longer carry `endpoint` / `apiKey` — those go through
  // `saveCredential` / `testCredential` (per-preset credential registry)
  // instead, for presets that have an HTTP surface at all.
  function buildGenInput(): AIGenProviderConfigInput {
    return {
      provider: genPresetId ?? '',
      chatModel: genChatModel.trim(),
    }
  }

  function buildEmbedInput(): AIEmbedProviderConfigInput {
    return {
      provider: embedPresetId ?? '',
      embeddingModel: embedModel.trim(),
    }
  }

  function buildImageInput(): AIImageProviderConfigInput {
    return {
      provider: imagePresetId ?? '',
      imageModel: imageModel.trim(),
    }
  }

  // Endpoint is hydrated from the credential registry when this preset
  // already has a row there (e.g. `custom`/`other-local` reused across the
  // gen and embed sub-stages), falling back to the catalog default
  // otherwise. Without this, re-picking the same open-ended preset in the
  // second sub-stage would reset the field to the catalog default and
  // silently overwrite the endpoint just saved for the first — the
  // registry holds exactly ONE endpoint per preset app-wide. Mirrors
  // `ProvidersTab`'s `credential?.endpoint ?? preset.endpoint`. The API
  // key is never rehydrated (the registry never exposes the raw key to the
  // frontend) — leaving it blank is intentional and preserves the stored
  // key on save (see `saveCredential` / `persist_provider_credential`).
  function resolveEndpoint(presetId: string, catalogDefault: string): string {
    return credentials.find((c) => c.presetId === presetId)?.endpoint ?? catalogDefault
  }

  const lastSeededFingerprint = useRef<string | null>(null)
  useEffect(() => {
    if (!isAdopt || !providers || !credentialsLoaded) return
    const fingerprint = adoptedAiSetupFingerprint(providers)
    if (lastSeededFingerprint.current === fingerprint) return
    lastSeededFingerprint.current = fingerprint
    const genDraft = seedAdoptSlotDraft(
      providers.generation?.provider,
      providers.generation?.chatModel,
      resolveEndpoint,
    )
    if (genDraft) {
      setGenPresetId(genDraft.presetId)
      setGenChatModel(genDraft.model)
      setGenEndpoint(genDraft.endpoint)
    }
    const imageDraft = seedAdoptSlotDraft(
      providers.image?.provider,
      providers.image?.imageModel,
      resolveEndpoint,
    )
    if (imageDraft) {
      setImagePresetId(imageDraft.presetId)
      setImageModel(imageDraft.model)
      setImageEndpoint(imageDraft.endpoint)
    }
    const embedDraft = seedAdoptSlotDraft(
      providers.embedding?.provider,
      providers.embedding?.embeddingModel,
      resolveEndpoint,
    )
    if (embedDraft) {
      setEmbedPresetId(embedDraft.presetId)
      setEmbedModel(embedDraft.model)
      setEmbedEndpoint(embedDraft.endpoint)
    }
    // Re-seed when the synced fingerprint changes (mid-pull can land chat
    // first, then image/embed). API key drafts are not touched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdopt, providers, credentials, credentialsLoaded])

  function goAfter(current: Stage) {
    const idx = stageOrder.indexOf(current)
    const next = idx >= 0 ? stageOrder[idx + 1] : undefined
    if (!next || (isAdopt && next === 'features')) {
      onComplete()
      return
    }
    if (next === 'embedding' && isAdopt) setEmbedExpanded(true)
    setStage(next)
  }

  function handleSelectGenPreset(id: string) {
    const preset = getPreset(id)
    if (!preset) return
    setGenPresetId(id)
    setGenEndpoint(resolveEndpoint(id, preset.endpoint))
    setGenApiKey('')
    setGenChatModel(preset.chatModel)
    setGenTest(null)
    setGenError(null)
  }

  function handleSelectEmbedPreset(id: string) {
    const preset = getPreset(id)
    if (!preset) return
    setEmbedPresetId(id)
    setEmbedEndpoint(resolveEndpoint(id, preset.endpoint))
    setEmbedApiKey('')
    setEmbedModel(preset.embeddingModel)
    setEmbedTest(null)
    setEmbedError(null)
  }

  function handleSelectImagePreset(id: string) {
    const preset = getPreset(id)
    if (!preset) return
    setImagePresetId(id)
    setImageEndpoint(resolveEndpoint(id, preset.endpoint))
    setImageApiKey('')
    setImageModel(preset.imageModel ?? '')
    setImageTest(null)
    setImageError(null)
  }

  async function handleTestGen() {
    setGenTest({ kind: 'running' })
    try {
      let result: { latencyMs: number; dim: number | null }
      if (genHasCredentialSurface) {
        const apiKeyValue = showGenApiKey && genApiKey.trim().length > 0 ? genApiKey.trim() : null
        result = await testCredential(
          genPresetId ?? '',
          genEndpoint.trim(),
          apiKeyValue,
          genChatModel.trim(),
        )
      } else {
        result = await testGeneration(buildGenInput())
      }
      setGenTest({ kind: 'ok', latencyMs: result.latencyMs, dim: result.dim })
    } catch (e) {
      setGenTest({ kind: 'error', message: describeError(e) })
    }
  }

  async function handleTestEmbed() {
    setEmbedTest({ kind: 'running' })
    try {
      let result: { latencyMs: number; dim: number | null }
      if (embedHasCredentialSurface) {
        const apiKeyValue =
          showEmbedApiKey && embedApiKey.trim().length > 0 ? embedApiKey.trim() : null
        result = await testCredential(
          embedPresetId ?? '',
          embedEndpoint.trim(),
          apiKeyValue,
          embedModel.trim(),
          'embed',
        )
      } else {
        result = await testEmbedding(buildEmbedInput())
      }
      setEmbedTest({ kind: 'ok', latencyMs: result.latencyMs, dim: result.dim })
    } catch (e) {
      setEmbedTest({ kind: 'error', message: describeError(e) })
    }
  }

  // Best-effort background download of the selected on-device chat model.
  // Guards on the Terms-of-Use gate exactly like `OnDeviceLlmModelPicker`:
  // if the model requires acceptance and none is on record, surface the ToU
  // modal instead of firing a download the backend will reject with
  // `terms_not_accepted`. The `.catch` handles the same rejection racing in
  // late (e.g. acceptance flag not yet hydrated).
  function kickLlmDownload(modelId: string) {
    const entry = llmCatalog.find((e) => e.id === modelId)
    if (entry?.requires_acceptance && !llmTermsAccepted) {
      setLlmTermsModalEntry(entry)
      return
    }
    void downloadLlmModel(modelId).catch((e) => {
      if (e instanceof TermsNotAcceptedError && entry) {
        setLlmTermsModalEntry(entry)
      }
      // Other download errors surface via footer / Settings; do not block
      // leaving the step. Best-effort fire-and-forget.
    })
  }

  async function handleAcceptLlmTerms() {
    const entry = llmTermsModalEntry
    if (!entry || acceptingLlmTerms) return
    setAcceptingLlmTerms(true)
    try {
      await acceptLlmTerms()
      setLlmTermsModalEntry(null)
      void downloadLlmModel(entry.id)
    } catch (e) {
      console.warn('AIStep: acceptTerms failed', e)
    } finally {
      setAcceptingLlmTerms(false)
    }
  }

  function handleLlmTermsLink(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    const url = llmTermsModalEntry?.terms_url
    if (url) void openUrl(url)
  }

  async function handleContinueGen() {
    setGenBusy(true)
    setGenError(null)
    try {
      let credentialRequiresConsent = false
      if (genHasCredentialSurface) {
        const apiKeyValue = showGenApiKey && genApiKey.trim().length > 0 ? genApiKey.trim() : null
        const credentialResult = await saveCredential(
          genPresetId ?? '',
          genEndpoint.trim(),
          apiKeyValue,
        )
        credentialRequiresConsent = credentialResult.requiresPrivacyConsent
      }
      const result = await saveGeneration(buildGenInput())
      // Integrated chat: kick model download in the background (parallel with
      // Drive connect / embed download). Do not await completion — user may
      // finish the wizard while multi-GB transfer runs; footer shows progress.
      if (isGenOnDevice && genChatModel.trim()) {
        const modelId = genChatModel.trim()
        if (shouldKickOnDeviceDownload(llmStates[modelId]?.status)) {
          kickLlmDownload(modelId)
        }
      }
      if (result.requiresPrivacyConsent || credentialRequiresConsent) {
        setPrivacyPromptFor('generation')
      } else {
        goAfter('provider')
      }
    } catch (e) {
      setGenError(describeError(e))
    } finally {
      setGenBusy(false)
    }
  }

  async function handleContinueEmbed() {
    setEmbedBusy(true)
    setEmbedError(null)
    try {
      let credentialRequiresConsent = false
      if (embedHasCredentialSurface) {
        const apiKeyValue =
          showEmbedApiKey && embedApiKey.trim().length > 0 ? embedApiKey.trim() : null
        const credentialResult = await saveCredential(
          embedPresetId ?? '',
          embedEndpoint.trim(),
          apiKeyValue,
        )
        credentialRequiresConsent = credentialResult.requiresPrivacyConsent
      }
      const result = await saveEmbedding(buildEmbedInput())
      setEmbeddingConfiguredThisSession(true)
      // Integrated embed: same background-download pattern as chat.
      // `useOnDeviceModels.download` is sync void + internal catch — just
      // call it (no try/catch theatre). Errors surface via footer events.
      if (isEmbedOnDevice && embedModel.trim()) {
        const modelId = embedModel.trim()
        if (shouldKickOnDeviceDownload(embedOnDeviceStates[modelId]?.status)) {
          downloadEmbedModel(modelId)
        }
      }
      if (result.requiresPrivacyConsent || credentialRequiresConsent) {
        setPrivacyPromptFor('embedding')
      } else {
        goAfter('embedding')
      }
    } catch (e) {
      setEmbedError(describeError(e))
    } finally {
      setEmbedBusy(false)
    }
  }

  async function handleTestImage() {
    setImageTest({ kind: 'running' })
    try {
      let result: { latencyMs: number; dim: number | null }
      if (imageHasCredentialSurface) {
        const apiKeyValue =
          showImageApiKey && imageApiKey.trim().length > 0 ? imageApiKey.trim() : null
        result = await testCredential(
          imagePresetId ?? '',
          imageEndpoint.trim(),
          apiKeyValue,
          imageModel.trim(),
        )
      } else {
        result = await testGeneration({
          provider: imagePresetId ?? '',
          chatModel: imageModel.trim(),
        })
      }
      setImageTest({ kind: 'ok', latencyMs: result.latencyMs, dim: result.dim })
    } catch (e) {
      setImageTest({ kind: 'error', message: describeError(e) })
    }
  }

  async function handleContinueImage() {
    setImageBusy(true)
    setImageError(null)
    try {
      let credentialRequiresConsent = false
      if (imageHasCredentialSurface) {
        const apiKeyValue =
          showImageApiKey && imageApiKey.trim().length > 0 ? imageApiKey.trim() : null
        const credentialResult = await saveCredential(
          imagePresetId ?? '',
          imageEndpoint.trim(),
          apiKeyValue,
        )
        credentialRequiresConsent = credentialResult.requiresPrivacyConsent
      }
      const result = await saveImage(buildImageInput())
      if (result.requiresPrivacyConsent || credentialRequiresConsent) {
        setPrivacyPromptFor('image')
      } else {
        goAfter('image')
      }
    } catch (e) {
      setImageError(describeError(e))
    } finally {
      setImageBusy(false)
    }
  }

  async function handleAcceptPrivacy() {
    const forSlot = privacyPromptFor
    try {
      await acceptPrivacy()
      setPrivacyPromptFor(null)
      if (forSlot === 'generation') goAfter('provider')
      else if (forSlot === 'image') goAfter('image')
      else if (forSlot === 'embedding') goAfter('embedding')
    } catch (e) {
      setPrivacyPromptFor(null)
      const msg = describeError(e)
      if (forSlot === 'generation') setGenError(msg)
      else if (forSlot === 'image') setImageError(msg)
      else setEmbedError(msg)
    }
  }

  function handleClosePrivacyPanel() {
    setPrivacyPromptFor(null)
  }

  /** Single Back handler for every sub-stage (see `AIStepProps.onExitStep`
   *  doc comment for why the shell's own footer Back is suppressed while
   *  this step is active). Within `embedding`, the expanded configure-form
   *  view and the collapsed configure-or-skip question are treated as their
   *  own steps so Back doesn't jump straight past the question a user just
   *  answered. */
  async function handleAcceptPrivacyAndFinish() {
    try {
      await acceptPrivacy()
      onComplete()
    } catch (e) {
      setEmbedError(describeError(e))
    }
  }

  function handleBack() {
    if (stage === 'embedding' && embedExpanded && !isAdopt) {
      setEmbedExpanded(false)
      return
    }
    const idx = stageOrder.indexOf(stage)
    if (idx <= 0) {
      onExitStep()
      return
    }
    const prev = stageOrder[idx - 1]
    // Coming back from `features`, land on the embedding sub-view that
    // matches what the user actually did: the filled-in form if they
    // configured it, the skip question if they didn't.
    if (prev === 'embedding') setEmbedExpanded(embedPresetId != null)
    setStage(prev)
  }

  async function handleToggleFeature(feature: AIFeature, next: boolean) {
    setFeatureError(null)
    try {
      await setFeature(feature, next)
    } catch (e) {
      setFeatureError(describeError(e))
    }
  }

  /** Master toggle: turn every available onboarding feature on or off in one
   *  gesture. Unavailable rows (need embedding / image model) are skipped
   *  when enabling; when disabling, every currently-on listed feature is
   *  turned off so nothing is left half-enabled. Uses `setFeatures` (one
   *  refresh) so the batch is not N full snapshot reloads. */
  async function handleToggleAllFeatures(next: boolean) {
    setFeatureError(null)
    setFeatureBusy(true)
    try {
      const targets = masterToggleTargets(ONBOARDING_FEATURES, next, embeddingConfigured, (f) =>
        isFeatureEnabled(settings, f),
      )
      await setFeatures(targets.map((feature) => ({ feature, enabled: next })))
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const partial = parsePartialFeatureUpdateError(raw)
      if (partial) {
        setFeatureError(
          t('onboarding.ai.features_partial_error', {
            applied: partial.applied,
            total: partial.total,
            message: partial.cause,
          }),
        )
      } else {
        setFeatureError(describeError(e))
      }
    } finally {
      setFeatureBusy(false)
    }
  }

  const cancelButton = onCancel ? (
    <Button variant="ghost" size="md" onClick={onCancel}>
      {t('ai:adopt_setup.cancel')}
    </Button>
  ) : null

  function renderTestResult(state: TestState) {
    if (!state || state.kind === 'running') return null
    if (state.kind === 'ok') {
      return (
        <p className="text-success flex items-center gap-1.5 text-xs">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {state.dim != null
            ? t('ai:test_result.ok_embed', { dim: state.dim, ms: state.latencyMs })
            : t('ai:test_result.ok_chat', { ms: state.latencyMs })}
        </p>
      )
    }
    return (
      <p role="alert" className="text-danger-text flex items-center gap-1.5 text-xs">
        <XCircle className="size-3.5" aria-hidden />
        {t('ai:test_result.fail', { message: state.message })}
      </p>
    )
  }

  const showAdoptPrivacy = isAdopt && (privacyPromptFor != null || stage === 'privacy')

  const backButton = (
    <Button
      variant="ghost"
      size="md"
      onClick={handleBack}
      disabled={
        (stage === 'provider' && genBusy) ||
        (stage === 'image' && imageBusy) ||
        (stage === 'embedding' && embedBusy) ||
        (stage === 'features' && (genBusy || embedBusy || featureBusy))
      }
    >
      {t('onboarding.back')}
    </Button>
  )

  const trailing = (nodes: ReactNode) => (
    <div className="flex items-center gap-2">
      {cancelButton}
      {nodes}
    </div>
  )

  let actions: ReactNode = null
  if (showAdoptPrivacy) {
    actions = (
      <>
        <Button
          variant="ghost"
          size="md"
          onClick={stage === 'privacy' ? handleBack : handleClosePrivacyPanel}
        >
          {t('onboarding.back')}
        </Button>
        {trailing(
          <Button
            variant="primary"
            size="md"
            onClick={() =>
              void (stage === 'privacy' ? handleAcceptPrivacyAndFinish() : handleAcceptPrivacy())
            }
          >
            {t('ai:action.accept_privacy', { defaultValue: 'I understand and agree' })}
          </Button>,
        )}
      </>
    )
  } else if (stage === 'enable') {
    actions = (
      <>
        {backButton}
        {trailing(
          <>
            <Button variant="ghost" size="md" onClick={onComplete}>
              {t('onboarding.ai.enable_no')}
            </Button>
            <Button variant="primary" size="md" onClick={() => setStage('provider')}>
              {t('onboarding.ai.enable_yes')}
            </Button>
          </>,
        )}
      </>
    )
  } else if (stage === 'provider') {
    actions = (
      <>
        {backButton}
        {trailing(
          <>
            {genPreset && !isGenOnDevice && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => void handleTestGen()}
                disabled={!canSubmitGen || genTest?.kind === 'running'}
              >
                {genTest?.kind === 'running' ? t('ai:action.testing') : t('onboarding.ai.test')}
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              loading={genBusy}
              disabled={!genPreset || !canSubmitGen || genBusy}
              onClick={() => void handleContinueGen()}
            >
              {t('onboarding.ai.continue')}
            </Button>
          </>,
        )}
      </>
    )
  } else if (stage === 'image') {
    actions = (
      <>
        {backButton}
        {trailing(
          <>
            <Button variant="ghost" size="md" onClick={() => goAfter('image')}>
              {t('onboarding.ai.embedding_skip')}
            </Button>
            {imagePreset && imageHasCredentialSurface && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => void handleTestImage()}
                disabled={!canSubmitImage || imageTest?.kind === 'running'}
              >
                {imageTest?.kind === 'running' ? t('ai:action.testing') : t('onboarding.ai.test')}
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              loading={imageBusy}
              disabled={!imagePreset || !canSubmitImage || imageBusy}
              onClick={() => void handleContinueImage()}
            >
              {t('onboarding.ai.continue')}
            </Button>
          </>,
        )}
      </>
    )
  } else if (stage === 'embedding' && !embedExpanded) {
    actions = (
      <>
        {backButton}
        {trailing(
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={() => (isAdopt ? goAfter('embedding') : setStage('features'))}
            >
              {t('onboarding.ai.embedding_skip')}
            </Button>
            <Button variant="primary" size="md" onClick={() => setEmbedExpanded(true)}>
              {t('onboarding.ai.embedding_configure')}
            </Button>
          </>,
        )}
      </>
    )
  } else if (stage === 'embedding' && embedExpanded) {
    actions = (
      <>
        {backButton}
        {trailing(
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={() => (isAdopt ? goAfter('embedding') : setStage('features'))}
            >
              {t('onboarding.ai.embedding_skip')}
            </Button>
            {embedPreset && (
              <>
                {!isEmbedOnDevice && (
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => void handleTestEmbed()}
                    disabled={!canSubmitEmbed || embedTest?.kind === 'running'}
                  >
                    {embedTest?.kind === 'running'
                      ? t('ai:action.testing')
                      : t('onboarding.ai.test')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="md"
                  loading={embedBusy}
                  disabled={!canSubmitEmbed || embedBusy}
                  onClick={() => void handleContinueEmbed()}
                >
                  {t('onboarding.ai.continue')}
                </Button>
              </>
            )}
          </>,
        )}
      </>
    )
  } else if (stage === 'features') {
    actions = (
      <>
        {backButton}
        {trailing(
          <Button variant="primary" size="md" onClick={onComplete} disabled={featureBusy}>
            {t('onboarding.finish')}
          </Button>,
        )}
      </>
    )
  }

  const actionBar = actions ? (
    <ActionBar
      chrome={chrome}
      className={chrome === 'inline' && stage === 'features' ? 'mt-4' : undefined}
    >
      {actions}
    </ActionBar>
  ) : null

  const body = (
    <div className="flex flex-col gap-4">
      {showAdoptPrivacy && (
        <AIPrivacyNoticePanel
          inline
          open
          mode="accept"
          hideActions={chrome === 'modal'}
          onAccept={() =>
            void (stage === 'privacy' ? handleAcceptPrivacyAndFinish() : handleAcceptPrivacy())
          }
          onClose={stage === 'privacy' ? handleBack : handleClosePrivacyPanel}
        />
      )}

      {!showAdoptPrivacy && stage === 'enable' && (
        // The shell renders no header for the AI step, so the first sub-stage
        // supplies its own title + explanation. Action buttons live in
        // ActionBar below (inline under the form, or Modal.Footer).
        <div className="flex flex-col">
          <div className="text-center">
            <h1 className="font-title text-fg text-2xl font-bold">{t('onboarding.ai.title')}</h1>
            <p className="text-fg-muted mt-2 text-sm">{t('onboarding.ai.explanation')}</p>
          </div>
        </div>
      )}

      {/* Provider choice + its config fields share one screen: the dropdown
          sits on top and, once a provider is picked, the endpoint/key/model
          fields reveal inline below it (mirrors the embedding sub-stage). */}
      {!showAdoptPrivacy && stage === 'provider' && (
        <div className="flex flex-col">
          <div className="flex flex-col gap-4">
            <div className="text-center">
              <h2 className="font-title text-fg text-lg font-bold">
                {t('onboarding.ai.provider_title')}
              </h2>
              <p className="text-fg-muted mt-1 text-sm">
                {t('onboarding.ai.provider_explanation')}
              </p>
            </div>
            <Select
              value={genPresetId ?? ''}
              onChange={handleSelectGenPreset}
              groups={genProviderGroups}
              placeholder={t('onboarding.ai.provider_title')}
              aria-label={t('onboarding.ai.provider_title')}
            />

            {genPreset && (
              <>
                {showGenEndpoint && (
                  <Field label={t('ai:field.endpoint')}>
                    <TextInput
                      value={genEndpoint}
                      onChange={setGenEndpoint}
                      disabled={genBusy || !genEndpointEditable}
                    />
                  </Field>
                )}
                {showGenApiKey && (
                  <Field label={t('ai:field.api_key')}>
                    <TextInput
                      type="password"
                      value={genApiKey}
                      onChange={setGenApiKey}
                      disabled={genBusy}
                      placeholder={t('ai:field.api_key_paste')}
                      autoComplete="off"
                    />
                  </Field>
                )}
                <Field
                  label={t('ai:field.chat_model')}
                  warning={
                    genPreset != null && providerUsesSubprocess(genPreset.id)
                      ? t('ai:cli_slow_warning')
                      : undefined
                  }
                >
                  {isGenOnDevice ? (
                    <Select
                      value={genChatModel}
                      onChange={setGenChatModel}
                      options={onDeviceLlmModelOptions}
                      placeholder={t('ai:field.chat_model')}
                      aria-label={t('ai:field.chat_model')}
                      disabled={genBusy || onDeviceLlmModelOptions.length === 0}
                      showTriggerDescription
                    />
                  ) : genModelOptions.length > 0 ? (
                    <ComboBox
                      value={genChatModel}
                      onChange={setGenChatModel}
                      options={genModelOptions}
                      placeholder={t('ai:field.chat_model')}
                      aria-label={t('ai:field.chat_model')}
                      disabled={genBusy}
                    />
                  ) : (
                    <TextInput value={genChatModel} onChange={setGenChatModel} disabled={genBusy} />
                  )}
                </Field>

                {isGenOnDevice && selectedLlmEntry && (
                  <div className="border-border-default bg-panel-2 rounded-xl border px-3 py-2.5">
                    <p className="text-fg-muted text-xs leading-relaxed">
                      {t(`ai:on_device_llm.models.${selectedLlmEntry.id}.when_to_choose`, {
                        defaultValue: selectedLlmEntry.when_to_choose,
                      })}
                    </p>
                    <ModelSpecRow
                      items={[
                        {
                          icon: HardDrive,
                          label: t('ai:on_device_llm.download_size_label', {
                            defaultValue: 'Size',
                          }),
                          value: `${(selectedLlmEntry.download_size_bytes / 1e9).toFixed(1)} GB`,
                        },
                        {
                          icon: MemoryStick,
                          label: t('ai:on_device_llm.min_ram_label', {
                            defaultValue: 'Min. RAM',
                          }),
                          value: `${selectedLlmEntry.min_ram_gb} GB`,
                        },
                        {
                          icon: Brackets,
                          label: t('ai:on_device_llm.context_label', {
                            defaultValue: 'Context',
                          }),
                          value: selectedLlmEntry.context_tokens.toLocaleString(),
                        },
                      ]}
                    />
                    {llmStates[selectedLlmEntry.id]?.status === 'ready' ? (
                      <p className="text-success mt-2 text-xs">
                        {t('onboarding.ai.integrated_model_ready')}
                      </p>
                    ) : (
                      <p className="text-fg-muted mt-2 text-xs">
                        {t('onboarding.ai.integrated_download_notice')}
                      </p>
                    )}
                  </div>
                )}

                {!isGenOnDevice && renderTestResult(genTest)}
                {genError && (
                  <p role="alert" className="text-danger-text text-xs">
                    {genError}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!showAdoptPrivacy && stage === 'image' && (
        <div className="flex flex-col">
          <div className="flex flex-col gap-4">
            <div className="text-center">
              <h2 className="font-title text-fg text-lg font-bold">
                {t('onboarding.ai.image_title')}
              </h2>
              <p className="text-fg-muted mt-1 text-sm">{t('onboarding.ai.image_explanation')}</p>
            </div>
            <Select
              value={imagePresetId ?? ''}
              onChange={handleSelectImagePreset}
              groups={imageProviderGroups}
              placeholder={t('onboarding.ai.provider_title')}
              aria-label={t('onboarding.ai.provider_title')}
            />

            {imagePreset && (
              <>
                {showImageEndpoint && (
                  <Field label={t('ai:field.endpoint')}>
                    <TextInput
                      value={imageEndpoint}
                      onChange={setImageEndpoint}
                      disabled={imageBusy || !imageEndpointEditable}
                    />
                  </Field>
                )}
                {showImageApiKey && (
                  <Field label={t('ai:field.api_key')}>
                    <TextInput
                      type="password"
                      value={imageApiKey}
                      onChange={setImageApiKey}
                      disabled={imageBusy}
                      placeholder={t('ai:field.api_key_paste')}
                      autoComplete="off"
                    />
                  </Field>
                )}
                <Field label={t('ai:field.image_model')}>
                  {imageModelOptions.length > 0 ? (
                    <ComboBox
                      value={imageModel}
                      onChange={setImageModel}
                      options={imageModelOptions}
                      placeholder={t('ai:field.image_model')}
                      aria-label={t('ai:field.image_model')}
                      disabled={imageBusy}
                    />
                  ) : (
                    <TextInput value={imageModel} onChange={setImageModel} disabled={imageBusy} />
                  )}
                </Field>
                {renderTestResult(imageTest)}
                {imageError && (
                  <p role="alert" className="text-danger-text text-xs">
                    {imageError}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!showAdoptPrivacy && stage === 'embedding' && !embedExpanded && (
        <div className="flex flex-col">
          <div className="text-center">
            <h2 className="font-title text-fg text-lg font-bold">
              {t('onboarding.ai.embedding_title')}
            </h2>
            <p className="text-fg-muted mt-1 text-sm">{t('onboarding.ai.embedding_explanation')}</p>
            <ul className="text-fg-secondary mx-auto mt-3 flex max-w-xs flex-col gap-1.5 text-left text-sm">
              {EMBEDDING_DEPENDENT_FEATURES.map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <CheckCircle2 className="text-accent size-4 shrink-0" aria-hidden />
                  {t(`ai:feature.${feature}.title`)}
                </li>
              ))}
            </ul>
            <p className="text-fg-muted mx-auto mt-4 max-w-xs text-xs">
              {t('onboarding.ai.embedding_dependent_note')}
            </p>
          </div>
        </div>
      )}

      {!showAdoptPrivacy && stage === 'embedding' && embedExpanded && (
        <div className="flex flex-col gap-4">
          <h2 className="font-title text-fg text-center text-lg font-bold">
            {t('onboarding.ai.provider_title')}
          </h2>
          <Select
            value={embedPresetId ?? ''}
            onChange={handleSelectEmbedPreset}
            groups={embedProviderGroups}
            placeholder={t('onboarding.ai.provider_title')}
            aria-label={t('onboarding.ai.provider_title')}
          />

          {embedPreset && (
            <>
              {showEmbedEndpoint && (
                <Field label={t('ai:field.endpoint')}>
                  <TextInput
                    value={embedEndpoint}
                    onChange={setEmbedEndpoint}
                    disabled={embedBusy || !embedEndpointEditable}
                  />
                </Field>
              )}
              {showEmbedApiKey && (
                <Field label={t('ai:field.api_key')}>
                  <TextInput
                    type="password"
                    value={embedApiKey}
                    onChange={setEmbedApiKey}
                    disabled={embedBusy}
                    placeholder={t('ai:field.api_key_paste')}
                    autoComplete="off"
                  />
                </Field>
              )}
              <Field label={t('ai:field.embedding_model')}>
                {isEmbedOnDevice ? (
                  <Select
                    value={embedModel}
                    onChange={setEmbedModel}
                    options={onDeviceEmbedModelOptions}
                    placeholder={t('ai:field.embedding_model')}
                    aria-label={t('ai:field.embedding_model')}
                    disabled={embedBusy || onDeviceEmbedModelOptions.length === 0}
                    showTriggerDescription
                  />
                ) : embedModelOptions.length > 0 ? (
                  <ComboBox
                    value={embedModel}
                    onChange={setEmbedModel}
                    options={embedModelOptions}
                    placeholder={t('ai:field.embedding_model')}
                    aria-label={t('ai:field.embedding_model')}
                    disabled={embedBusy}
                  />
                ) : (
                  <TextInput value={embedModel} onChange={setEmbedModel} disabled={embedBusy} />
                )}
              </Field>

              {isEmbedOnDevice && selectedEmbedOnDeviceEntry && (
                <div className="border-border-default bg-panel-2 rounded-xl border px-3 py-2.5">
                  <p className="text-fg-muted text-xs leading-relaxed">
                    {t(
                      `ai:on_device_models.models.${selectedEmbedOnDeviceEntry.id}.when_to_choose`,
                      { defaultValue: selectedEmbedOnDeviceEntry.whenToChoose },
                    )}
                  </p>
                  <ModelSpecRow
                    items={[
                      {
                        icon: HardDrive,
                        label: t('ai:on_device_models.download_size_label', {
                          defaultValue: 'Download size',
                        }),
                        value: t(
                          `ai:on_device_models.models.${selectedEmbedOnDeviceEntry.id}.download_size`,
                          { defaultValue: selectedEmbedOnDeviceEntry.downloadSize },
                        ),
                      },
                      {
                        icon: MemoryStick,
                        label: t('ai:on_device_models.approx_ram_label', {
                          defaultValue: 'Approx. RAM',
                        }),
                        value: t(
                          `ai:on_device_models.models.${selectedEmbedOnDeviceEntry.id}.approx_ram`,
                          { defaultValue: selectedEmbedOnDeviceEntry.approxRam },
                        ),
                      },
                      {
                        icon: Brackets,
                        label: t('ai:on_device_models.dim_context_label', {
                          defaultValue: 'Dim / context',
                        }),
                        value: `${selectedEmbedOnDeviceEntry.dim}d · ${selectedEmbedOnDeviceEntry.contextLength}`,
                      },
                    ]}
                  />
                  {embedOnDeviceStates[selectedEmbedOnDeviceEntry.id]?.status === 'ready' ? (
                    <p className="text-success mt-2 text-xs">
                      {t('onboarding.ai.integrated_model_ready')}
                    </p>
                  ) : (
                    <p className="text-fg-muted mt-2 text-xs">
                      {t('onboarding.ai.integrated_download_notice')}
                    </p>
                  )}
                </div>
              )}

              {!isEmbedOnDevice && renderTestResult(embedTest)}
              {embedError && (
                <p role="alert" className="text-danger-text text-xs">
                  {embedError}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {!showAdoptPrivacy && stage === 'features' && (
        <div className="flex flex-col gap-4">
          <div className="text-center">
            <h2 className="font-title text-fg text-lg font-bold">
              {t('onboarding.ai.features_title')}
            </h2>
            <p className="text-fg-muted mt-1 text-sm">{t('onboarding.ai.features_explanation')}</p>
          </div>
          {featureError && (
            <p role="alert" className="text-danger-text text-center text-xs">
              {featureError}
            </p>
          )}
          <div className="border-border-default bg-elevated flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
            <div className="min-w-0">
              <p className="text-fg text-sm font-medium">{t('onboarding.ai.features_all_title')}</p>
              <p className="text-fg-muted text-xs">{t('onboarding.ai.features_all_description')}</p>
            </div>
            <Toggle
              checked={allFeaturesEnabled}
              onChange={(next) => void handleToggleAllFeatures(next)}
              ariaLabel={t('onboarding.ai.features_all_title')}
              disabled={featureBusy || toggleableFeatures.length === 0}
            />
          </div>
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
            {ONBOARDING_FEATURES.map((feature) => {
              // Keep unavailable reasons explicit for per-row copy; gate
              // matches `isFeatureUnavailable` (master toggle uses the same
              // helper so enable-all never drifts from disabled rows).
              const needsEmbedding =
                EMBEDDING_DEPENDENT_FEATURES.includes(feature) && !embeddingConfigured
              // Onboarding never collects an image model (the generation
              // sub-stage only asks for endpoint/key/chat model), so this
              // toggle is always disabled here — never silently enabled for
              // something that can't run. See `Settings → AI` to configure
              // an image model and turn this on.
              const needsImageModel = feature === 'image_generation'
              const unavailable = isFeatureUnavailable(feature, embeddingConfigured)
              const disabled = unavailable || featureBusy
              return (
                <div
                  key={feature}
                  className="border-border-default bg-elevated flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-fg text-sm font-medium">
                      {t(`ai:feature.${feature}.title`)}
                    </p>
                    <p className="text-fg-muted text-xs">
                      {t(`ai:feature.${feature}.description`)}
                    </p>
                    {needsEmbedding && (
                      <p className="text-warning-text mt-0.5 text-xs italic">
                        {t('onboarding.ai.feature_needs_embedding')}
                      </p>
                    )}
                    {needsImageModel && (
                      <p className="text-warning-text mt-0.5 text-xs italic">
                        {t('onboarding.ai.feature_needs_image_model')}
                      </p>
                    )}
                  </div>
                  <Toggle
                    checked={isFeatureEnabled(settings, feature)}
                    onChange={(next) => void handleToggleFeature(feature, next)}
                    ariaLabel={t(`ai:feature.${feature}.title`)}
                    disabled={disabled}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <>
      {chrome === 'modal' ? (
        <>
          <Modal.Body>{body}</Modal.Body>
          {actionBar}
        </>
      ) : (
        <>
          {body}
          {actionBar}
        </>
      )}

      {!isAdopt && (
        <AIPrivacyNoticePanel
          open={privacyPromptFor != null}
          mode="accept"
          onAccept={() => void handleAcceptPrivacy()}
          onClose={handleClosePrivacyPanel}
        />
      )}

      {llmTermsModalEntry && (
        <Modal onClose={() => !acceptingLlmTerms && setLlmTermsModalEntry(null)}>
          <Modal.Header>
            {t('ai:on_device_llm.terms.title', { defaultValue: 'Gemma Terms of Use' })}
          </Modal.Header>
          <Modal.Body fitContent>
            <p className="text-fg-secondary text-sm leading-relaxed">
              {t('ai:on_device_llm.terms.summary', {
                defaultValue:
                  "Gemma models are licensed under Google's Gemma Terms of Use. You must accept these terms before downloading a model to this device. Memlore stores a local acceptance receipt; it is not synced.",
              })}
            </p>
            {llmTermsModalEntry.terms_url && (
              <a
                href={llmTermsModalEntry.terms_url}
                onClick={handleLlmTermsLink}
                className="text-accent mt-3 inline-flex items-center gap-1.5 text-sm underline-offset-2 hover:underline"
              >
                {t('ai:on_device_llm.terms.link_label', {
                  defaultValue: 'Read the Gemma Terms of Use',
                })}
                <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
              </a>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLlmTermsModalEntry(null)}
              disabled={acceptingLlmTerms}
            >
              {t('ai:on_device_llm.terms.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              size="sm"
              onClick={() => void handleAcceptLlmTerms()}
              disabled={acceptingLlmTerms}
            >
              {t('ai:on_device_llm.terms.accept', { defaultValue: 'Accept' })}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </>
  )
}
