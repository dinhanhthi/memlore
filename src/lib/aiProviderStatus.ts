import type { SelectOption } from '../components/common/Select'
import {
  getPresetsByCapability,
  getPreset,
  providerIsOnDevice,
  providerUsesSubprocess,
} from '../types/ai'
import type {
  EndpointClass,
  ProviderCapability,
  ProviderCredential,
  ProviderPreset,
} from '../types/ai'

/** `local` and `on-device` are both privacy-exempt endpoint classes — no
 *  journal content leaves the machine, so neither needs the hosted privacy
 *  notice accepted. Mirrors the backend's `requires_privacy_consent` logic
 *  (see `switching_hosted_to_on_device_clears_hosted_consent_requirement`
 *  in `commands/ai_provider.rs`), which auto-exempts on-device the same
 *  way it already auto-exempts local HTTP servers.
 *
 *  Extracted from `AISettingsPanel.tsx` (T3.2) so `ProvidersTab`'s
 *  per-preset status dot can share the exact same rule instead of
 *  re-deriving it. */
export function isPrivacyExemptClass(cls: EndpointClass): boolean {
  return cls === 'local' || cls === 'on-device'
}

/** Status-dot colour for a preset's credential state.
 *  🟢 ready (API key present if required, and privacy accepted if needed)
 *  🟡 configured but missing something → warning
 *  ⚪ (callers return this themselves when there's no state to evaluate yet)
 *
 *  Shared between `AISettingsPanel`'s two-slot cards (keyed by whichever
 *  preset the active generation/embedding slot currently points at) and
 *  `ProvidersTab`'s per-preset credential rows (keyed by every preset's
 *  registry row, whether or not a slot is using it right now) — same
 *  formula, different caller shape. */
export function presetStatusColor(
  presetId: string,
  hasApiKey: boolean,
  endpointClass: EndpointClass,
  privacyAcceptedAt: number | null,
): string {
  const preset = getPreset(presetId)
  if (preset?.requiresApiKey && !hasApiKey) return 'bg-warning'
  if (!isPrivacyExemptClass(endpointClass) && privacyAcceptedAt == null) return 'bg-warning'
  return 'bg-success'
}

/** True when a preset counts as "configured" for `ProvidersTab`'s shown-set
 *  (T3.7 — the flat, no-accordion redesign). The shown set is
 *  `addedProviders ∪ { presets where this is true }` — a safety property so
 *  a preset with a stored credential can never become invisible even if
 *  the user never explicitly "added" it (e.g. a save made before the
 *  added-list existed).
 *
 *  - `cli` (subprocess) presets are ALWAYS unconfigured — their only
 *    "configured" signal would be the CLI's own install/sign-in state,
 *    which this frontend has no synchronous read of; they only ever
 *    appear via the added-list.
 *  - `integrated` (on-device / on-device-llm) presets are configured iff
 *    `hasDownloadedIntegratedModel` — the caller ORs together
 *    `getReadyModels`/`getReadyLlmModels` from both on-device catalogs
 *    (`useOnDeviceModels` / `useOnDeviceLlmModels`), since the two presets
 *    render as ONE merged "Integrated" section.
 *  - `hosted` (incl. `custom`) presets are configured when `hasApiKey` OR
 *    an endpoint override is on file.
 *  - `local` presets (ollama/lmstudio/llama-server/other-local) are
 *    keyless — configured only when an endpoint override is on file.
 *
 *  CRITICAL: "endpoint override exists" is NOT `credential != null` and
 *  NOT `credential.endpoint !== ''`. `get_ai_provider_credentials` returns
 *  a row for every preset with `endpoint` populated from the catalog
 *  default when nothing has been overridden — e.g. a never-touched
 *  `ollama` row already reads `http://127.0.0.1:11434/v1`. An override
 *  exists IFF the credential's endpoint differs from `PROVIDER_PRESETS`'
 *  own `endpoint` for that preset id. Comparing against `!= ''` would
 *  wrongly mark every fresh `ollama`/`other-local` row (non-empty
 *  built-in defaults) as configured. */
export function providerIsConfigured(
  presetId: string,
  credential: ProviderCredential | undefined,
  hasDownloadedIntegratedModel: boolean,
): boolean {
  if (providerUsesSubprocess(presetId)) return false
  if (providerIsOnDevice(presetId)) return hasDownloadedIntegratedModel
  const preset = getPreset(presetId)
  if (!preset) return false
  const hasEndpointOverride = credential != null && credential.endpoint !== preset.endpoint
  if (preset.group === 'hosted') return credential?.hasApiKey === true || hasEndpointOverride
  return hasEndpointOverride
}

/** True when a SLOT (generation / image / embedding) points at a provider
 *  that is actually set up **on this device**.
 *
 *  Why this is not `config != null`: the slot's provider/model selection is a
 *  synced setting (`ai_gen_provider`, `ai_embed_provider`, … in
 *  `SYNCABLE_SETTING_KEYS`), but the credential that makes it usable is not —
 *  the keyring is deliberately device-local, and the privacy receipt is a
 *  per-device act. So a device that adopts an existing cloud vault hydrates
 *  every slot with `config != null` while having nothing to call with. Gating
 *  features on `!= null` there leaves them enabled and failing at call time.
 *
 *  Why an API-key check alone isn't enough either (the rule this replaced):
 *  `preset.requiresApiKey && hasApiKey` says nothing about keyless presets. An
 *  `on-device` preset with no model downloaded, or an `ollama` preset with no
 *  endpoint on file, requires no key and would pass — which is exactly the
 *  freshly-synced state we need to reject.
 *
 *  So this composes the two checks the Providers tab already uses:
 *  - `isProviderConnected` — the same Connected/Available split that tab
 *    renders (on-device needs a downloaded model, local needs an endpoint
 *    override, hosted needs a key or override, CLI needs an explicit add).
 *  - `presetNeedsApiKey` — closes the one hole `isProviderConnected` leaves:
 *    `ai_provider_endpoints` DOES sync, so a hosted preset with a synced
 *    endpoint override reports connected on a device that has no key.
 */
export function slotIsConnected(
  config: { provider: string; hasApiKey: boolean } | null | undefined,
  credentialByPreset: Map<string, ProviderCredential>,
  addedProviders: readonly string[],
  hasDownloadedIntegratedModel: boolean,
): boolean {
  if (!config) return false
  const connected = isProviderConnected(
    config.provider,
    credentialByPreset.get(config.provider),
    addedProviders,
    hasDownloadedIntegratedModel,
  )
  return connected && !presetNeedsApiKey(config.provider, config.hasApiKey)
}

/** Default probe model + capability resolved for `ProvidersTab`'s per-preset
 *  Test button (T3.5), from the preset's OWN curated suggestion list —
 *  the same value the feature-tab model combobox would pre-select.
 *
 *  Embed-only presets (only `voyage` today) resolve
 *  `embeddingModelSuggestions[0]` with `capability: 'embed'` so the backend
 *  probes `/embeddings` instead of `/chat/completions`. Every other
 *  suggestion-bearing preset resolves `chatModelSuggestions[0]` with no
 *  explicit capability (the backend defaults to a chat probe).
 *
 *  Presets with NO suggestion list (currently only `custom`) resolve
 *  `probeModel: undefined` — callers must supply their own free-text probe
 *  model instead of relying on this resolver, since the backend rejects an
 *  undefined probe model for the `custom` group. */
export function resolveProbeModel(preset: ProviderPreset): {
  probeModel: string | undefined
  capability: 'embed' | undefined
} {
  const embedOnly = preset.capabilities.length === 1 && preset.capabilities[0] === 'embed'
  if (embedOnly) {
    return { probeModel: preset.embeddingModelSuggestions?.[0]?.value, capability: 'embed' }
  }
  return { probeModel: preset.chatModelSuggestions?.[0]?.value, capability: undefined }
}

/* `isSlotUsable` / `noProviderConfigured` lived here. Both asked only "does
   this preset require an API key, and is one present", which passes a keyless
   preset (on-device, ollama) that has no model downloaded and no endpoint on
   file — the exact state a device inherits when it adopts a cloud vault.
   `slotIsConnected` above supersedes them for the whole AI Settings panel.
   Two `!= null` slot checks remain outside it — see docs/LATER.md →
   "Slot-connected gating stops at the AI Settings panel". */

// ─── Tab-dot / attention banners (AI Settings page) ──────────────────────────
// Kept pure so the page banner and the Providers/Models status dots share one
// rule set: a yellow tab dot without an explanatory banner is a product bug.

/** Status-dot colour for one AI Settings model slot (chat / image / embed).
 *  🟢 connected + privacy accepted when required
 *  🟡 chosen but not usable here (no credential / no model / privacy)
 *  🟤 nothing chosen yet */
export function slotDotColor(
  config: { provider: string; hasApiKey: boolean; endpointClass: EndpointClass } | null | undefined,
  connected: boolean,
  privacyAcceptedAt: number | null,
): 'bg-success' | 'bg-warning' | 'bg-empty' {
  if (config != null && !connected) return 'bg-warning'
  if (!config) return 'bg-empty'
  const color = presetStatusColor(
    config.provider,
    config.hasApiKey,
    config.endpointClass,
    privacyAcceptedAt,
  )
  return color === 'bg-warning' ? 'bg-warning' : 'bg-success'
}

/** Worst of several slot dots. Warning outranks empty outranks success so a
 *  tab never reads "fine" while any slot behind it still needs attention. */
export function worstSlotStatusColor(
  colors: ReadonlyArray<'bg-success' | 'bg-warning' | 'bg-empty' | string>,
): string {
  const rank = (c: string) => (c === 'bg-warning' ? 2 : c === 'bg-empty' ? 1 : 0)
  return colors.reduce((worst, c) => (rank(c) > rank(worst) ? c : worst), 'bg-success')
}

/** Model-slot ids the AI Settings Models tab owns. */
export type AiModelSlotId = 'chat' | 'image' | 'embed'

/** One reason the Providers/Models tabs show a yellow (or brown) attention
 *  signal — used to render the page-level warning banners. */
export type AiSetupAttentionIssue =
  /** No chat/image/embedding slot is usable on this device, and no slot has
   *  even been chosen yet (true greenfield — not a synced-but-keyless vault). */
  | { kind: 'no_provider' }
  /** A non-local slot is selected but the privacy notice is not accepted. */
  | { kind: 'privacy' }
  /** Slot(s) have a provider/model chosen (synced) but are not connected here. */
  | { kind: 'slots_not_connected'; slots: AiModelSlotId[] }
  /** Chat works but no embedding model has been chosen yet — semantic search /
   *  memory stay dark. `modelsTabDotColor` promotes this from brown empty to
   *  yellow warning so both tab dots and the banner agree. */
  | { kind: 'embed_not_configured' }

export interface AiSlotAttentionInput {
  config: { provider: string; hasApiKey: boolean; endpointClass: EndpointClass } | null | undefined
  connected: boolean
}

/** Models-tab status colour for the three slots. Applies two product rules
 *  on top of the raw per-slot dots:
 *  1. Image is optional — an unset image slot does not keep the tab brown
 *     after chat (+ embedding) are ready.
 *  2. Chat ready + embedding never chosen → promote embed's brown empty to
 *     yellow warning (matches `embed_not_configured` attention issue). */
export function modelsTabDotColor(input: {
  gen: AiSlotAttentionInput
  image: AiSlotAttentionInput
  embed: AiSlotAttentionInput
  privacyAcceptedAt: number | null
}): string {
  const { gen, image, embed, privacyAcceptedAt } = input
  const embedDot = slotDotColor(embed.config, embed.connected, privacyAcceptedAt)
  const embedAttention =
    gen.connected && embed.config == null && embedDot === 'bg-empty' ? 'bg-warning' : embedDot
  const imageDot =
    image.config != null
      ? slotDotColor(image.config, image.connected, privacyAcceptedAt)
      : 'bg-success'
  return worstSlotStatusColor([
    slotDotColor(gen.config, gen.connected, privacyAcceptedAt),
    imageDot,
    embedAttention,
  ])
}

/** Providers-tab status colour. Yellow when nothing is connected here, or
 *  when the Models aggregate itself is warning (privacy / half-connected
 *  slot / missing embedding after chat is ready). */
export function providersTabDotColor(modelsDot: string, anyProviderConnected: boolean): string {
  return !anyProviderConnected || modelsDot === 'bg-warning' ? 'bg-warning' : 'bg-success'
}

/** Derive the explanatory banners that must accompany the Providers/Models
 *  status dots. Pure — no i18n, no React.
 *
 *  - True greenfield (every slot unset, nothing connected) → `no_provider`
 *    only (T3.6 banner).
 *  - Synced-but-keyless vault (slots chosen, none connected here) →
 *    `slots_not_connected` (+ privacy if needed), never the misleading
 *    "add a provider" copy — the provider is already chosen.
 *  - Partial setup (at least one slot connected) → remaining yellow-dot
 *    causes listed so the page never shows a silent warning indicator. */
export function resolveAiSetupAttention(input: {
  gen: AiSlotAttentionInput
  image: AiSlotAttentionInput
  embed: AiSlotAttentionInput
  privacyAcceptedAt: number | null
}): AiSetupAttentionIssue[] {
  const { gen, image, embed, privacyAcceptedAt } = input
  const anyConnected = gen.connected || image.connected || embed.connected

  const slots: Array<{ id: AiModelSlotId; slot: AiSlotAttentionInput }> = [
    { id: 'chat', slot: gen },
    { id: 'image', slot: image },
    { id: 'embed', slot: embed },
  ]

  const notConnected = slots
    .filter(({ slot }) => slot.config != null && !slot.connected)
    .map(({ id }) => id)
  const anyChosen = slots.some(({ slot }) => slot.config != null)

  // Greenfield: nothing chosen, nothing connected. The classic T3.6 banner.
  if (!anyConnected && !anyChosen) return [{ kind: 'no_provider' }]

  const issues: AiSetupAttentionIssue[] = []

  // Nothing usable yet, but at least one slot already points at a provider
  // (typical new-device / vault-adopt path). Tell the user which slots need
  // a credential here — do NOT claim "no provider configured".
  if (!anyConnected && notConnected.length > 0) {
    issues.push({ kind: 'slots_not_connected', slots: notConnected })
  }

  const needsPrivacy = slots.some(
    ({ slot }) =>
      slot.config != null &&
      !isPrivacyExemptClass(slot.config.endpointClass) &&
      privacyAcceptedAt == null,
  )
  if (needsPrivacy) issues.push({ kind: 'privacy' })

  // Partial setup: some slots work, others still need a credential here.
  if (anyConnected && notConnected.length > 0) {
    issues.push({ kind: 'slots_not_connected', slots: notConnected })
  }

  // Chat ready + embedding never chosen. Models tab promotes this to yellow
  // via `modelsTabDotColor`; the banner must explain it.
  if (gen.connected && embed.config == null) {
    issues.push({ kind: 'embed_not_configured' })
  }

  return issues
}

/**
 * Privacy receipt for setup banners / tab dots.
 *
 * `useAIProviderConfig` remounts with `settings: null` every time Settings
 * → AI is opened, while the provider snapshot often already lives in the
 * store. Treating that unread `null` as "not accepted" flashes the privacy
 * Callout for one frame. `known: false` means "do not warn yet".
 */
export function resolveSetupPrivacyReceipt(input: {
  hasSettings: boolean
  settingsPrivacyAcceptedAt: number | null
  storeHydrated: boolean
  storePrivacyAcceptedAt: number | null
}): { known: boolean; acceptedAt: number | null } {
  if (input.hasSettings) return { known: true, acceptedAt: input.settingsPrivacyAcceptedAt }
  if (input.storeHydrated) return { known: true, acceptedAt: input.storePrivacyAcceptedAt }
  return { known: false, acceptedAt: null }
}

/** Slot configs and the privacy receipt must both be known before we
 *  derive banners or yellow tab dots. Unread providers look like
 *  greenfield (`no_provider`); unread privacy looks like a missing
 *  receipt. Either one flashes a warning that then vanishes. */
export function isAiSetupAttentionReady(input: {
  providersKnown: boolean
  privacyKnown: boolean
}): boolean {
  return input.providersKnown && input.privacyKnown
}

/** True when a preset needs an API key and none is on file for it —
 *  the "Needs API key" / disabled state for `ProviderPicker` (T4.1).
 *  Keyless-usable presets (local Ollama/LM Studio/…, CLI subprocess,
 *  on-device) are never "unconfigured" for lacking a key: they don't
 *  need one, so they must stay enabled. Reuses the exact same
 *  `preset.requiresApiKey` field `presetStatusColor` above already
 *  keys off, so the feature-tab dropdown and the Providers-tab status
 *  dot never disagree about what counts as "configured". */
export function presetNeedsApiKey(presetId: string, hasApiKey: boolean): boolean {
  const preset = getPreset(presetId)
  return !!preset?.requiresApiKey && !hasApiKey
}

/** The two reasons a preset can be disabled in the MEMORY provider dropdown
 *  (T5.1) — one more than the feature-tab `ProviderPicker` above, because
 *  memory slots are backend-enforced to Local/OnDevice class unless
 *  `ai_memory_allow_hosted` is on (`enforce_memory_slot_class` in
 *  `commands/ai_settings.rs`). `null` means the preset is selectable. */
export type MemoryPresetDisabledReason = 'needs_key' | 'hosted_blocked' | null

/** Resolves which of the two reasons (if any) disables a preset in the
 *  memory provider dropdown. Precedence: `'hosted_blocked'` wins over
 *  `'needs_key'` when both apply — e.g. a hosted preset with neither a key
 *  nor hosted-memory allowed. Enabling hosted memory is the prerequisite
 *  either way (the backend rejects the slot save on class alone, key or
 *  not), so sending the user to "add a key" first would still dead-end at
 *  the class check; once `allowHosted` is already on, a preset missing
 *  only a key correctly falls through to `'needs_key'`.
 *
 *  `endpointClass` must come from the preset's per-preset credential row
 *  (`getAiProviderCredentials`), not the static catalog `group` — mirrors
 *  the backend's `classify_memory_disclosure`, which also derives from the
 *  resolved (preset, endpoint) pair rather than a static grouping. */
export function memoryPresetDisabledReason(
  presetId: string,
  hasApiKey: boolean,
  endpointClass: EndpointClass,
  allowHosted: boolean,
): MemoryPresetDisabledReason {
  if ((endpointClass === 'remote' || endpointClass === 'subscription') && !allowHosted) {
    return 'hosted_blocked'
  }
  if (presetNeedsApiKey(presetId, hasApiKey)) return 'needs_key'
  return null
}

/** True when a preset needs the `ai_memory_allow_hosted` acknowledgement —
 *  i.e. its resolved endpoint class is `remote` (hosted HTTP) or
 *  `subscription` (CLI), so journal content leaves the machine. `local`
 *  and `on-device` need neither.
 *
 *  T5.2: replaces an earlier stopgap that branched on the catalog's static
 *  `group` (`preset.group === 'hosted'`), which misclassified a `custom`
 *  preset pointed at a loopback endpoint as hosted (the `custom` preset
 *  folds into `group: 'hosted'` in the catalog regardless of where its
 *  endpoint actually points). `endpointClass` is the DERIVED class from
 *  the per-preset credential registry — the same source the backend's
 *  `enforce_memory_slot_class` uses — so a `custom` preset at
 *  `http://127.0.0.1:...` now correctly resolves to `local` and does not
 *  require the ack.
 *
 *  CLI presets already resolve to `endpointClass: 'subscription'` via the
 *  backend's `classify_provider_disclosure` (the subprocess check happens
 *  before the endpoint is ever classified), so no separate
 *  `providerUsesSubprocess` check is needed on the frontend either — it's
 *  already baked into the resolved class. */
export function requiresHostedAck(endpointClass: EndpointClass | null | undefined): boolean {
  return endpointClass === 'remote' || endpointClass === 'subscription'
}

/** The three headings the MEMORY provider dropdown groups presets under —
 *  same names `MemoriesSettings` already renders (`group.local` /
 *  `group.subscription` / `group.hosted`), but derived from the preset's
 *  resolved `endpointClass` (T5.2) instead of the catalog's static
 *  `group`, so a `custom` preset pointed at a loopback endpoint groups
 *  with the other on-machine options instead of always under "Hosted". */
export type MemoryPresetDisplayGroup = 'local' | 'subscription' | 'hosted'

export function classifyMemoryPresetGroup(
  endpointClass: EndpointClass | null | undefined,
): MemoryPresetDisplayGroup {
  if (endpointClass === 'subscription') return 'subscription'
  if (endpointClass === 'remote') return 'hosted'
  return 'local'
}

/** True when a preset is "connected" for the feature-tab Provider
 *  dropdown — same union `ProvidersTab` uses for its Connected list:
 *  explicitly added (`addedProviders`) OR already configured
 *  (`providerIsConfigured`). On-device presets NEVER count via
 *  `addedProviders` — their only connection signal is a downloaded model,
 *  so a stale added-list entry (e.g. Connect clicked, download cancelled)
 *  can't present an empty catalog as connected. */
export function isProviderConnected(
  presetId: string,
  credential: ProviderCredential | undefined,
  addedProviders: readonly string[],
  hasDownloadedIntegratedModel: boolean,
): boolean {
  if (!providerIsOnDevice(presetId) && addedProviders.includes(presetId)) return true
  return providerIsConfigured(presetId, credential, hasDownloadedIntegratedModel)
}

/** Builds the flat, connected-only option list for the feature-tab
 *  Provider dropdown. Capability-filtered, no group headings, no
 *  disabled "Needs API key" rows — unconnected presets simply do not
 *  appear (connect them on the Providers tab first).
 *
 *  `readyOnDevice` is the per-integrated-preset download signal:
 *  `embed` for `on-device`, `llm` for `on-device-llm`. Other presets
 *  ignore it.
 *
 *  When `currentValue` is set but not currently connected (stale slot
 *  after a disconnect), it is appended so the Select can still display
 *  the saved selection instead of going blank. */
export function buildConnectedProviderOptions(
  capability: ProviderCapability,
  credentialByPreset: Map<string, ProviderCredential>,
  addedProviders: readonly string[],
  readyOnDevice: { embed: boolean; llm: boolean },
  currentValue?: string,
): SelectOption[] {
  const source = getPresetsByCapability(capability)
  const options: SelectOption[] = source
    .filter((p) => {
      const hasDownloaded =
        p.id === 'on-device'
          ? readyOnDevice.embed
          : p.id === 'on-device-llm'
            ? readyOnDevice.llm
            : false
      return isProviderConnected(p.id, credentialByPreset.get(p.id), addedProviders, hasDownloaded)
    })
    .map((p) => ({ value: p.id, label: p.label }))

  if (
    currentValue &&
    !options.some((o) => o.value === currentValue) &&
    source.some((p) => p.id === currentValue)
  ) {
    const preset = source.find((p) => p.id === currentValue)!
    options.push({ value: preset.id, label: preset.label })
  }

  return options
}
