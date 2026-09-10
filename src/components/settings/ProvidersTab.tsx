import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAIProviderConfig } from '../../hooks/useAIProviderConfig'
import { useCliProviderHealth } from '../../hooks/useCliProviderHealth'
import { getReadyLlmModels, useOnDeviceLlmModels } from '../../hooks/useOnDeviceLlmModels'
import { getReadyModels, useOnDeviceModels } from '../../hooks/useOnDeviceModels'
import { providerIsConfigured, resolveProbeModel } from '../../lib/aiProviderStatus'
import { cn } from '../../lib/cn'
import { errMsg } from '../../lib/errMsg'
import { useUiStore } from '../../stores/uiStore'
import {
  PROVIDER_PRESETS,
  providerIsOnDevice,
  providerUsesSubprocess,
  type PresetGroup,
  type ProviderCredential,
  type ProviderPreset,
  type TestCredentialOutcome,
} from '../../types/ai'
import { OnDeviceLlmModelPicker } from '../ai/OnDeviceLlmModelPicker'
import { OnDeviceModelPicker } from '../ai/OnDeviceModelPicker'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { Tooltip } from '../common/Tooltip'
import { AIProviderSetupHint } from './AIProviderSetupHint'
import { ApiKeyField, LabeledInput } from './ApiKeyField'
import { CliProviderHealthView, CliRecheckButton } from './CliProviderHealthStatus'
import { disconnectConfirmCopy, disconnectWipesCredential } from './providerDisconnect'

/**
 * AI Settings → Providers tab. Two flat sections separated by hairline
 * dividers (same global settings style as the General page):
 *
 *  - **Connected providers** — presets the user connected (persisted in
 *    `uiStore.addedProviders`) UNION every preset `providerIsConfigured`
 *    reports as configured, so a preset with a stored credential can never
 *    hide in "Available". On-device cards are the exception: they count as
 *    connected purely by having a downloaded model on disk. Cards show
 *    name + short description and a Config + Disconnect button pair
 *    (on-device cards get Config only).
 *  - **Available providers** — everything else, as minimal cards with a
 *    single Connect button.
 *
 * The credential form (endpoint, API key, Test, Save) and the on-device
 * download catalogs live in a per-provider modal opened by Connect /
 * Config — never inline in the list.
 *
 * Component tests are NOT written per CLAUDE.md — UI changes too fast.
 */
interface ProvidersTabProps {
  /** Surfaces async failures (on-device model select/save) to the parent's
   *  global `AIPageFooter` error banner — same `onError` contract every
   *  other AI-settings tab component takes from `AISettingsPanel`. */
  onError: (msg: string | null) => void
  /** Opens the global privacy consent modal, pre-set to 'accept' — same
   *  `openPrivacyPanel('accept')` mechanism `MemoriesSettings` already
   *  uses. Triggered on the first hosted-credential save, additively —
   *  the slot-save privacy gate and the `set_ai_feature` gate are
   *  unchanged. */
  onPrivacyPrompt: () => void
}

export function ProvidersTab({ onError, onPrivacyPrompt }: ProvidersTabProps) {
  const { t } = useTranslation('ai')
  const {
    credentials,
    saveCredential,
    forgetCredential,
    testCredential,
    providers,
    saveGeneration,
    saveEmbedding,
    forgetGeneration,
    forgetEmbedding,
  } = useAIProviderConfig()
  const genConfig = providers?.generation ?? null
  const embedConfig = providers?.embedding ?? null

  // The active on-device LLM chat model id, or `null` when the generation
  // slot isn't on-device / isn't configured — passed into the picker so it
  // can show the "Selected" radio state on the right row.
  const currentOnDeviceLlmChatModelId =
    genConfig != null && genConfig.provider === 'on-device-llm' ? genConfig.chatModel : null

  // The active on-device model id, or `null` when the embedding slot isn't
  // on-device / isn't configured — passed into `OnDeviceModelPicker` so it
  // can show the "Current" badge and offer "Use for embedding" on the
  // other, already-downloaded models.
  const currentOnDeviceModelId =
    embedConfig != null && embedConfig.provider === 'on-device' ? embedConfig.embeddingModel : null

  /** Switch the generation slot's chat model to a downloaded on-device LLM
   *  catalog id. Goes through `saveGeneration` (not `invoke()` directly)
   *  so the slot persistence + provider rebuild + refresh all happen the
   *  way a normal Save does. The on-device-llm preset has no endpoint and
   *  no API key, so both are passed empty/null — the backend fills the
   *  real localhost llama-server port when it spawns the sidecar. */
  async function handleSelectOnDeviceLlmChatModel(modelId: string) {
    try {
      await saveGeneration({
        provider: 'on-device-llm',
        chatModel: modelId,
      })
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    }
  }

  /** Switch the embedding slot to a different, already-downloaded on-device
   *  model. Goes through `saveEmbedding` (not `invoke()` directly) so the
   *  slot persistence, rebuild-enqueue, and refresh all happen exactly the
   *  way a normal Save does. */
  async function handleUseOnDeviceModelForEmbedding(modelId: string) {
    try {
      await saveEmbedding({
        provider: 'on-device',
        embeddingModel: modelId,
      })
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    }
  }

  // Lifted here (in ADDITION to the pickers' own internal hook calls inside
  // their modals) to compute whether each on-device card counts as
  // connected and which downloaded model names it lists.
  // Two independent hook mounts is a deliberate, minor duplication traded
  // for keeping `OnDeviceModelPicker` / `OnDeviceLlmModelPicker`'s existing
  // self-contained prop contract unchanged (reuse, don't reinvent).
  const embedModels = useOnDeviceModels(currentOnDeviceModelId)
  const llmModels = useOnDeviceLlmModels()
  const readyEmbedModels = getReadyModels(embedModels.catalog, embedModels.states)
  const readyLlmModels = getReadyLlmModels(llmModels.catalog, llmModels.states)

  const addedProviders = useUiStore((s) => s.addedProviders)
  const addProvider = useUiStore((s) => s.addProvider)
  const removeProvider = useUiStore((s) => s.removeProvider)
  const pendingOpenPresetId = useUiStore((s) => s.pendingOpenPresetId)
  const clearPendingOpenPresetId = useUiStore((s) => s.clearPendingOpenPresetId)

  const credentialByPreset = useMemo(() => {
    const map = new Map<string, ProviderCredential>()
    for (const c of credentials) map.set(c.presetId, c)
    return map
  }, [credentials])

  /** The provider modal currently open — a preset id, or `null` for closed.
   *  One modal serves both the Connect flow (from Available) and the Config
   *  flow (from Connected): the form is identical, only how the user got
   *  there differs. */
  const [modalKey, setModalKey] = useState<string | null>(null)
  /** Card key pending Disconnect confirmation. Every kind confirms — only
   *  the copy differs: credentialed presets say the stored endpoint/API key
   *  gets wiped, the rest say nothing is deleted from the device. */
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null)

  // Cross-tab "reveal this provider" request (feature tabs' disabled-option
  // jumps + on-device empty-state links + MemoriesSettings' `needs_key`
  // action). Consuming it now means opening that preset's modal directly —
  // the form the caller wanted the user to land on.
  useEffect(() => {
    if (pendingOpenPresetId == null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consumes uiStore's one-shot cross-tab "reveal this provider" request, then clears it
    setModalKey(pendingOpenPresetId)
    clearPendingOpenPresetId()
  }, [pendingOpenPresetId, clearPendingOpenPresetId])

  // Connected set = `addedProviders` ∪ every preset `providerIsConfigured`
  // reports as configured — the union is a safety property so a preset
  // with a stored credential can never sit under "Available".
  const isConnected = (presetId: string) =>
    addedProviders.includes(presetId) ||
    providerIsConfigured(presetId, credentialByPreset.get(presetId), false)

  // The two built-in on-device providers get one card each — chat models
  // (`on-device-llm`, a llama-server sidecar) and the embedding model
  // (`on-device`, fastembed in-process). They used to share a single merged
  // "Integrated" card, which meant the chat-model deep link from the Chat &
  // Image tab could only ever open a modal listing both catalogs.
  const onDeviceCards = [
    {
      id: 'on-device-llm',
      title: t('providers_tab.integrated_chat_title', {
        defaultValue: 'Integrated chat models',
      }),
      description: t('on_device_llm.section_description', {
        defaultValue: 'Download once, then chat fully offline on this device.',
      }),
      readyNames: readyLlmModels.map((m) => m.display_name),
      picker: (
        <OnDeviceLlmModelPicker
          currentChatModelId={currentOnDeviceLlmChatModelId}
          onSelectChatModel={(id) => void handleSelectOnDeviceLlmChatModel(id)}
          forgetGeneration={forgetGeneration}
          showDescription={false}
        />
      ),
    },
    {
      id: 'on-device',
      title: t('providers_tab.integrated_embed_title', {
        defaultValue: 'Integrated embedding models',
      }),
      description: t('on_device_models.section_description', {
        defaultValue: 'Runs fully offline on this device once downloaded.',
      }),
      readyNames: readyEmbedModels.map((m) => m.displayName),
      picker: (
        <OnDeviceModelPicker
          currentModelId={currentOnDeviceModelId}
          onUseForEmbedding={handleUseOnDeviceModelForEmbedding}
          onBeforeRemoveCurrent={() => forgetEmbedding()}
          showDescription={false}
        />
      ),
    },
  ]

  // On-device connection state is purely disk-based: connected iff at least
  // one model of that kind is downloaded. `addedProviders` is deliberately
  // NOT consulted — Connect alone (catalog opened, nothing downloaded, e.g.
  // the Gemma ToU modal dismissed) must not move the card to Connected.
  const onDeviceConnected = (card: (typeof onDeviceCards)[number]) => card.readyNames.length > 0

  const regularPresets = PROVIDER_PRESETS.filter((p) => !providerIsOnDevice(p.id))
  const connectedPresets = regularPresets.filter((p) => isConnected(p.id))
  const availablePresets = regularPresets.filter((p) => !isConnected(p.id))
  const connectedOnDeviceCards = onDeviceCards.filter(onDeviceConnected)
  const availableOnDeviceCards = onDeviceCards.filter((c) => !onDeviceConnected(c))

  function handleConnect(key: string) {
    // Connect only opens the provider's modal. On-device providers have no
    // credential to enter, but they must NOT be marked connected here —
    // that state is disk-based (`onDeviceConnected`) and only flips once a
    // model actually finishes downloading.
    setModalKey(key)
  }

  /** Closing a catalog modal re-hydrates the tab's own copy of the download
   *  state. Downloads and removals already broadcast Tauri events (`ai:model-removed`);
   *  this refresh is a belt-and-suspenders re-read after the picker closes. */
  function closeOnDeviceModal() {
    setModalKey(null)
    void llmModels.refresh()
    void embedModels.refresh()
  }

  function handleDisconnect(key: string) {
    // Every kind confirms first — a mis-click on a CLI card used to
    // disconnect it silently, with no way back except re-connecting.
    setConfirmDisconnectId(key)
  }

  async function handleConfirmedDisconnect(key: string) {
    setConfirmDisconnectId(null)
    try {
      if (disconnectWipesCredential(key)) {
        // Only credentialed presets have a registry row to wipe. Same
        // predicate the confirm dialog's copy came from, so what the user
        // was promised and what runs can never drift.
        await forgetCredential(key)
        removeProvider(key)
      } else {
        removeProvider(key)
      }
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    }
  }

  // On-device presets get their own catalog modals below, so they must not
  // also match the generic credential-form modal.
  const modalPreset =
    modalKey != null && !providerIsOnDevice(modalKey)
      ? PROVIDER_PRESETS.find((p) => p.id === modalKey)
      : undefined

  function providerDescription(presetId: string): string {
    return t(`providers_tab.desc.${presetId}`, { defaultValue: '' })
  }

  // Available list is long — group by privacy class so the user can scan
  // Local / On-device / CLI / Hosted without reading every description.
  // (Not memoised: inputs are re-filtered each render and the grouping is
  // cheap; wrapping it in useMemo trips the React Compiler preserve rule.)
  const availableGroupOrder: PresetGroup[] = ['local', 'integrated', 'cli', 'hosted']
  const availableBuckets: Record<PresetGroup, ProviderPreset[]> = {
    local: [],
    integrated: [],
    cli: [],
    hosted: [],
  }
  for (const preset of availablePresets) {
    availableBuckets[preset.group].push(preset)
  }
  const availableByGroup = availableGroupOrder
    .map((id) => ({
      id,
      label: t(`group.${id}`, { defaultValue: id }),
      presets: availableBuckets[id],
      // On-device cards share the integrated privacy class.
      onDevice: id === 'integrated' ? availableOnDeviceCards : [],
    }))
    .filter((g) => g.presets.length > 0 || g.onDevice.length > 0)

  return (
    <div className="space-y-5">
      {/* ── Connected providers ───────────────────────────────────────────
          Section label outside (same as Available). Body matches Available
          group cards (surface-hi + shared ProviderRow hover) but no in-card
          group-header strip — Connected is a single list, not privacy groups. */}
      <div className="space-y-2">
        <h3 className="text-fg-muted text-sm font-medium">
          {t('providers_tab.connected_title', { defaultValue: 'Connected providers' })}
        </h3>
        <section className="border-border-card bg-surface-hi overflow-hidden rounded-2xl border">
          {connectedPresets.length === 0 && connectedOnDeviceCards.length === 0 ? (
            <p className="text-fg-muted px-4 py-3.5 text-sm">
              {t('providers_tab.connected_empty', { defaultValue: 'No providers connected yet.' })}
            </p>
          ) : (
            <div className="divide-border-default divide-y">
              {connectedPresets.map((preset) => (
                <ProviderRow
                  key={preset.id}
                  title={preset.label}
                  description={providerDescription(preset.id)}
                  warning={providerUsesSubprocess(preset.id) ? t('cli_slow_warning') : undefined}
                  connected
                  actions={
                    <>
                      <Button variant="secondary" size="xs" onClick={() => setModalKey(preset.id)}>
                        {t('providers_tab.config', { defaultValue: 'Config' })}
                      </Button>
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => handleDisconnect(preset.id)}
                      >
                        {t('providers_tab.disconnect', { defaultValue: 'Disconnect' })}
                      </Button>
                    </>
                  }
                />
              ))}
              {connectedOnDeviceCards.map((card) => (
                <ProviderRow
                  key={card.id}
                  title={card.title}
                  description={providerDescription(card.id)}
                  connected
                  extra={
                    // Unconditional: `onDeviceConnected` already guarantees a
                    // card in this list has at least one downloaded model.
                    <p className="text-fg-muted mt-0.5 truncate pl-4 text-xs">
                      {t('providers_tab.downloaded_models', { defaultValue: 'Downloaded:' })}{' '}
                      <span className="text-fg-secondary">{card.readyNames.join(', ')}</span>
                    </p>
                  }
                  actions={
                    <>
                      <Button variant="secondary" size="xs" onClick={() => setModalKey(card.id)}>
                        {t('providers_tab.config', { defaultValue: 'Config' })}
                      </Button>
                      {/* No Disconnect: an on-device card is only ever here
                          while a model is on disk, and removing that model
                          (per-model Remove inside Config) is what moves it
                          back to Available. */}
                    </>
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ── Available providers ──────────────────────────────────────────
          One surface card per privacy class (Local / On-device / CLI /
          Hosted). Title sits at the top of each card, a hairline divides
          it from the provider rows. */}
      <div className="space-y-2">
        <h3 className="text-fg-muted text-sm font-medium">
          {t('providers_tab.available_title', { defaultValue: 'Available providers' })}
        </h3>
        {availableByGroup.length === 0 ? (
          <section className="border-border-card bg-surface-hi overflow-hidden rounded-2xl border">
            <p className="text-fg-muted px-4 py-3.5 text-sm">
              {t('providers_tab.available_empty', {
                defaultValue: 'All providers are connected.',
              })}
            </p>
          </section>
        ) : (
          <div className="space-y-3">
            {availableByGroup.map((group) => (
              <section
                key={group.id}
                className="border-border-card bg-surface-hi overflow-hidden rounded-2xl border"
              >
                <h4 className="text-fg border-border-default bg-surface-group-header border-b px-4 py-2.5 text-sm font-semibold">
                  {group.label}
                </h4>
                <div className="divide-border-default divide-y">
                  {group.presets.map((preset) => (
                    <ProviderRow
                      key={preset.id}
                      title={preset.label}
                      description={providerDescription(preset.id)}
                      warning={
                        providerUsesSubprocess(preset.id) ? t('cli_slow_warning') : undefined
                      }
                      connected={false}
                      actions={
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => handleConnect(preset.id)}
                        >
                          {t('providers_tab.connect', { defaultValue: 'Connect' })}
                        </Button>
                      }
                    />
                  ))}
                  {group.onDevice.map((card) => (
                    <ProviderRow
                      key={card.id}
                      title={card.title}
                      description={providerDescription(card.id)}
                      connected={false}
                      actions={
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => handleConnect(card.id)}
                        >
                          {t('providers_tab.connect', { defaultValue: 'Connect' })}
                        </Button>
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ── Provider modal (Connect / Config) ─────────────────
          One catalog modal per on-device provider. Closing either does NOT
          cancel an in-flight download — the backend owns those and reports
          progress via events, so the footer download chip keeps tracking it. */}
      {onDeviceCards.map((card) =>
        modalKey === card.id ? (
          <Modal key={card.id} onClose={closeOnDeviceModal} maxWidth={560}>
            <Modal.Header description={card.description}>{card.title}</Modal.Header>
            {/* Body does not scroll — the picker scrolls only the model list. */}
            <Modal.Body scroll={false}>{card.picker}</Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" size="sm" onClick={closeOnDeviceModal}>
                {t('action.close', { defaultValue: 'Close' })}
              </Button>
            </Modal.Footer>
          </Modal>
        ) : null,
      )}

      {modalPreset != null && (
        <Modal onClose={() => setModalKey(null)} maxWidth={520}>
          <Modal.Header
            description={
              // Only mount the hint when copy exists — an empty element would
              // still reserve the header description gap.
              t(`provider_hint.${modalPreset.id}`, { defaultValue: '' }) ? (
                <AIProviderSetupHint preset={modalPreset} />
              ) : undefined
            }
          >
            {modalPreset.label}
          </Modal.Header>
          {modalPreset.group === 'cli' ? (
            /* Like the credential form, this owns Body AND Footer — it holds
               the `useCliProviderHealth` probe so the footer's Recheck button
               and the status box share ONE probe instead of two. */
            <CliProviderModalContent
              preset={modalPreset}
              model={
                genConfig != null && genConfig.provider === modalPreset.id
                  ? genConfig.chatModel
                  : modalPreset.chatModel
              }
              connected={isConnected(modalPreset.id)}
              onClose={() => setModalKey(null)}
              onConnect={() => {
                addProvider(modalPreset.id)
                setModalKey(null)
              }}
            />
          ) : (
            /* The credential form owns Body AND Footer so its draft state
               (endpoint / apiKey / saving / testState) stays local while its
               Save + Test buttons live in the footer. `Modal` just renders
               `children` into a flex column, so a fragment composes fine. */
            <ProviderCredentialForm
              key={modalPreset.id}
              preset={modalPreset}
              credential={credentialByPreset.get(modalPreset.id)}
              saveCredential={saveCredential}
              testCredential={testCredential}
              onPrivacyPrompt={onPrivacyPrompt}
              onClose={() => setModalKey(null)}
              onSaved={() => {
                addProvider(modalPreset.id)
                setModalKey(null)
              }}
            />
          )}
        </Modal>
      )}

      {/* ── Disconnect confirm ───────────────────────────────────────────
          Credentialed presets get the destructive copy (the stored endpoint
          + API key are wiped); CLI gets the softer copy, since
          disconnecting it only drops the card from the connected list. */}
      {confirmDisconnectId != null && (
        <Modal onClose={() => setConfirmDisconnectId(null)} maxWidth={460}>
          <Modal.Header description={t(disconnectConfirmCopy(confirmDisconnectId).bodyKey)}>
            {t(disconnectConfirmCopy(confirmDisconnectId).titleKey)}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnectId(null)}>
              {t('action.forget_cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmedDisconnect(confirmDisconnectId)}
            >
              {t('providers_tab.disconnect', { defaultValue: 'Disconnect' })}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}

// ─── CLI provider modal (inside the provider modal) ──────────────────────────

interface CliProviderModalContentProps {
  preset: ProviderPreset
  /** Chat model forwarded to the Codex probe — see `useCliProviderHealth`. */
  model: string
  /** Whether the preset is already in the connected list (hides Connect). */
  connected: boolean
  onClose: () => void
  onConnect: () => void
}

/** Body + Footer for a CLI-backed provider's modal. Owns the health probe so
 *  the footer's Recheck sits next to Close (user request) while the status
 *  box in the body renders from the SAME probe — mounting
 *  `CliProviderHealthStatus` and a second `useCliProviderHealth` for the
 *  button would fire two 3–8 s subprocess probes on every open.
 *
 *  Body is omitted while the probe has nothing to show (web harness / not
 *  yet settled) so the modal is header + separator + footer only — no empty
 *  padded body region. */
function CliProviderModalContent({
  preset,
  model,
  connected,
  onClose,
  onConnect,
}: CliProviderModalContentProps) {
  const { t } = useTranslation('ai')
  const cliHealth = useCliProviderHealth(preset.id, model)
  // Mirror the non-null branches of `CliProviderHealthView` so the body
  // mounts only when that view would actually paint something.
  const hasBodyContent =
    (cliHealth.loading && !cliHealth.health) || cliHealth.error != null || cliHealth.health != null

  return (
    <>
      {hasBodyContent && (
        <Modal.Body fitContent>
          <CliProviderHealthView providerId={preset.id} {...cliHealth} hideRecheck />
        </Modal.Body>
      )}
      <Modal.Footer>
        {/* `mr-auto` left-floats the actions inside the footer's
            `justify-end` row, leaving Close pinned right — same layout the
            credential form's footer uses, so both provider modals put their
            actions in the same place. */}
        <div className="mr-auto flex items-center gap-2">
          {!connected && (
            <Button variant="secondary" size="sm" onClick={onConnect}>
              {t('providers_tab.connect', { defaultValue: 'Connect' })}
            </Button>
          )}
          <CliRecheckButton loading={cliHealth.loading} onClick={cliHealth.recheck} />
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('action.close', { defaultValue: 'Close' })}
        </Button>
      </Modal.Footer>
    </>
  )
}

// ─── Provider list row ────────────────────────────────────────────────────────

interface ProviderRowProps {
  title: string
  description: string
  /** True in the Connected section (green dot), false in Available
   *  (gray dot). */
  connected: boolean
  /** Optional amber warning icon + tooltip next to the provider name
   *  (e.g. CLI latency notice for Claude CLI / Codex CLI). */
  warning?: string
  /** Extra line under the description — e.g. an on-device card's
   *  downloaded-model names. */
  extra?: React.ReactNode
  actions: React.ReactNode
}

/** One provider row: status dot + name + short description on the left,
 *  action buttons on the right.
 *
 *  Surface ladder (AI settings card groups):
 *    card body      → surface-hi
 *    row hover      → surface-row-hover  (lighter than the card)
 *    secondary btn  → surface-control / surface-control-hover
 *  Secondary styling lives on `<Button variant="secondary">` itself so
 *  Connect/Config stay readable without per-row overrides. */
function ProviderRow({ title, description, connected, warning, extra, actions }: ProviderRowProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-3',
        'hover:bg-surface-row-hover transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
        'motion-reduce:transition-none',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-fg flex items-center gap-2 text-sm font-medium">
          <span
            className={cn('size-2 shrink-0 rounded-full', connected ? 'bg-success' : 'bg-fg-muted')}
            aria-hidden="true"
          />
          <span className="truncate">{title}</span>
          {warning && (
            <Tooltip content={warning} multiline placement="top">
              <button
                type="button"
                aria-label={warning}
                className="text-warning hover:text-warning-text inline-flex shrink-0 cursor-help items-center rounded-full outline-none"
              >
                <AlertTriangle
                  className="size-3.5 shrink-0"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              </button>
            </Tooltip>
          )}
        </p>
        {description !== '' && (
          <p className="text-fg-muted mt-0.5 truncate pl-4 text-xs leading-snug">{description}</p>
        )}
        {extra}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  )
}

// ─── Credential form (inside the provider modal) ─────────────────────────────

interface ProviderCredentialFormProps {
  preset: ProviderPreset
  credential: ProviderCredential | undefined
  saveCredential: ReturnType<typeof useAIProviderConfig>['saveCredential']
  testCredential: ReturnType<typeof useAIProviderConfig>['testCredential']
  onPrivacyPrompt: () => void
  /** Dismisses the modal from the footer's Close button. */
  onClose: () => void
  /** Called after a successful save — the parent marks the preset
   *  connected and closes the modal. */
  onSaved: () => void
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; result: TestCredentialOutcome }
  | { kind: 'error'; message: string }

/** Human-readable "ok" line for a Test result — same 3-way split
 *  `AIStep.tsx`'s `renderTestResult` already uses (`dim != null` → embed
 *  probe happened), plus a `local` branch for the group that never makes a
 *  chat/embed call at all (reachability + model-list check only). */
function testOkMessageKey(group: ProviderPreset['group'], result: TestCredentialOutcome): string {
  if (group === 'local') return 'test_result.ok_local'
  if (result.dim != null) return 'test_result.ok_embed'
  return 'test_result.ok_chat'
}

/** Numeric detail shown next to the "ok" line — latency always, plus
 *  whichever of `dim` / `modelCount` the backend populated (at most one,
 *  per `TestCredentialOutcome`'s contract). */
function testDetailText(result: TestCredentialOutcome, t: TFunction<'ai'>): string {
  if (result.modelCount != null) {
    return t('providers_tab.test_models_found', { count: result.modelCount, ms: result.latencyMs })
  }
  if (result.dim != null) {
    return t('providers_tab.test_detail_embed', { dim: result.dim, ms: result.latencyMs })
  }
  return t('providers_tab.test_detail_latency', { ms: result.latencyMs })
}

/** Endpoint + API-key form for one preset, backed directly by the
 *  per-preset credential registry. Lives inside the provider modal — the
 *  Connect flow and the Config flow share it unchanged. Disconnect/forget
 *  is NOT here: the Connected card's Disconnect button owns that.
 *
 *  Test button is per-group, same `test_ai_provider_credential` routing
 *  the backend already does:
 *  - `hosted` (except `custom`) — probes with the preset's own first
 *    suggested model (`resolveProbeModel`).
 *  - `custom` — needs a caller-supplied probe model; the button stays
 *    disabled until the extra "test model" field is non-empty.
 *  - `local` — reachability + model-list check only, labelled and
 *    tooltipped to say so; no probe model needed.
 *
 *  The endpoint field only renders for endpoint-editable presets
 *  (`custom` / `other-local`, per `endpointEditable`) — fixed hosted/local
 *  presets have a baked-in endpoint the user can't usefully change, so
 *  showing a disabled field just adds visual noise. */
function ProviderCredentialForm({
  preset,
  credential,
  saveCredential,
  testCredential,
  onPrivacyPrompt,
  onClose,
  onSaved,
}: ProviderCredentialFormProps) {
  const { t } = useTranslation('ai')
  const [endpoint, setEndpoint] = useState(credential?.endpoint ?? preset.endpoint)
  const [hasEditedEndpoint, setHasEditedEndpoint] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasExplicitlyEditedApiKey, setHasExplicitlyEditedApiKey] = useState(false)
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testModel, setTestModel] = useState('')
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' })

  // The credentials fetch can resolve AFTER the modal is already open (the
  // modal mounts on click; `credentials` starts `[]` until `refresh()`'s
  // IPC lands). Without a resync, the draft keeps the preset default and a
  // Save would silently DELETE the stored endpoint override on the backend
  // (`endpoints.remove(preset_id)` when the value equals the default).
  // Render-time state adjustment (not an effect) per React's syncing-state-
  // to-props pattern; never clobbers an endpoint the user already edited.
  const [prevCredential, setPrevCredential] = useState(credential)
  if (credential !== prevCredential) {
    setPrevCredential(credential)
    if (!hasEditedEndpoint) setEndpoint(credential?.endpoint ?? preset.endpoint)
  }

  // Transient feedback — same 2s auto-dismiss the previous inline row used.
  useEffect(() => {
    if (testState.kind !== 'ok' && testState.kind !== 'error') return
    const id = setTimeout(() => setTestState({ kind: 'idle' }), 2000)
    return () => clearTimeout(id)
  }, [testState])

  const endpointEditable = preset.id === 'custom' || preset.id === 'other-local'
  const showApiKeyField = preset.requiresApiKey || preset.group !== 'local' || showApiKeyInput
  const isCustom = preset.id === 'custom'
  const isLocalGroup = preset.group === 'local'
  const suggested = resolveProbeModel(preset)
  const testDisabled =
    testState.kind === 'running' ||
    (isCustom && (testModel.trim() === '' || endpoint.trim() === ''))

  function resolveApiKeyValue(): string | null {
    return showApiKeyField && (apiKey.length > 0 || hasExplicitlyEditedApiKey) ? apiKey : null
  }

  async function handleSave() {
    setSaving(true)
    try {
      const outcome = await saveCredential(preset.id, endpoint.trim(), resolveApiKeyValue())
      setError(null)
      // First hosted-credential save (or any save that lands on an
      // endpoint class not yet accepted) — additive convenience prompt.
      // The slot-save privacy gate and `set_ai_feature` gate are
      // untouched; this never substitutes for either.
      if (outcome.requiresPrivacyConsent) onPrivacyPrompt()
      onSaved()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTestState({ kind: 'running' })
    try {
      const probeModel = isCustom ? testModel.trim() : suggested.probeModel
      const capability = isCustom ? undefined : suggested.capability
      const result = await testCredential(
        preset.id,
        endpoint.trim(),
        resolveApiKeyValue(),
        probeModel,
        capability,
      )
      setTestState({ kind: 'ok', result })
    } catch (e) {
      setTestState({ kind: 'error', message: errMsg(e) })
    }
  }

  const testButton = (
    <Button
      variant="secondary"
      size="sm"
      loading={testState.kind === 'running'}
      disabled={testDisabled}
      onClick={() => void handleTest()}
    >
      {testState.kind === 'running'
        ? t('action.testing')
        : isLocalGroup
          ? t('providers_tab.test_local_button')
          : t('action.test')}
    </Button>
  )

  return (
    <>
      <Modal.Body>
        <div className="space-y-3">
          {endpointEditable && (
            <LabeledInput
              label={t('field.endpoint')}
              value={endpoint}
              onChange={(v) => {
                setEndpoint(v)
                setHasEditedEndpoint(true)
              }}
            />
          )}
          {showApiKeyField ? (
            <ApiKeyField
              label={preset.requiresApiKey ? t('field.api_key') : t('field.api_key_optional')}
              value={apiKey}
              onChange={(v) => {
                setApiKey(v)
                setHasExplicitlyEditedApiKey(true)
              }}
              hasStoredKey={!!credential?.hasApiKey && !hasExplicitlyEditedApiKey}
              onReplace={() => {
                setApiKey('')
                setHasExplicitlyEditedApiKey(true)
              }}
              placeholder={t('field.api_key_paste')}
            />
          ) : (
            <button
              type="button"
              className="text-accent hover:text-accent-hover text-sm underline"
              onClick={() => setShowApiKeyInput(true)}
            >
              + {t('field.api_key_optional')}
            </button>
          )}

          {/* `custom` has zero built-in model suggestions — the backend rejects
              a probe with no model, so the free-text field is the only way this
              preset's Test button can ever become enabled. */}
          {isCustom && (
            <LabeledInput
              label={t('providers_tab.test_model_label')}
              value={testModel}
              onChange={setTestModel}
              placeholder={t('providers_tab.test_model_placeholder')}
            />
          )}

          {/* Save/Test feedback stays in the body, not the footer: a provider
              error string can be arbitrarily long, and reflowing the footer
              would shift the buttons out from under the user's cursor. */}
          {error && <p className="text-danger-text text-sm">{error}</p>}
          {testState.kind === 'ok' && (
            <div className="text-success-text flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>{t(testOkMessageKey(preset.group, testState.result))}</span>
              <span className="text-fg-muted text-xs">{testDetailText(testState.result, t)}</span>
            </div>
          )}
          {testState.kind === 'error' && (
            <div className="text-danger-text flex items-start gap-1.5 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{t('test_result.fail', { message: testState.message })}</span>
            </div>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        {/* `mr-auto` left-floats the actions inside the footer's
            `justify-end` row, leaving Close pinned to the right. */}
        <div className="mr-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {t('action.save')}
          </Button>
          {isLocalGroup ? (
            <Tooltip content={t('providers_tab.test_local_hint')}>{testButton}</Tooltip>
          ) : (
            testButton
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('action.close', { defaultValue: 'Close' })}
        </Button>
      </Modal.Footer>
    </>
  )
}
