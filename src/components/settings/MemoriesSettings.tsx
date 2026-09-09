import {
  AlertTriangle,
  Brain,
  CircleHelp,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { ComboBox, type ComboBoxOption } from '../common/ComboBox'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Modal } from '../common/Modal'
import { Select, type SelectOption } from '../common/Select'
import { TextInput } from '../common/TextInput'
import { Tooltip } from '../common/Tooltip'
import { MemoryScanHelpPanel } from './MemoryScanHelpPanel'
import { SettingsRow } from './SettingsRow'
import { Toggle } from './Toggle'
import { buildConnectedProviderOptions, requiresHostedAck } from '../../lib/aiProviderStatus'
import { buildModelOptions } from '../../lib/modelOptions'
import { useMemoryAllowHosted } from '../../hooks/useMemoryAllowHosted'
import { useMemoryIncludeProtected } from '../../hooks/useMemoryIncludeProtected'
import { useOllamaInstalledModels } from '../../hooks/useOllamaInstalledModels'
import { getReadyLlmModels, useOnDeviceLlmModels } from '../../hooks/useOnDeviceLlmModels'
import { getReadyModels, useOnDeviceModels } from '../../hooks/useOnDeviceModels'
import { useUserMemory } from '../../hooks/useUserMemory'
import { errMsg, filterMemoryItemsByQuery, formatLastScanned } from '../../lib/memorySettings'
import { setAiFeature } from '../../lib/tauri'
import { useAiSettingsStore } from '../../stores/aiSettingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useUiStore } from '../../stores/uiStore'
import {
  getPreset,
  getPresetsByCapability,
  providerIsOnDevice,
  providerUsesSubprocess,
  type AIMemoryEmbedProviderConfig,
  type AIMemoryEmbedProviderConfigInput,
  type AIMemoryGenProviderConfig,
  type AIMemoryGenProviderConfigInput,
  type EndpointClass,
  type ModelSuggestion,
  type ProviderCapability,
  type ProviderCredential,
  type ProviderPreset,
} from '../../types/ai'

/**
 * Settings → AI → Memory tab. Persona moved to its own tab — see
 * `PersonaSettings.tsx`.
 *
 * Sections, top-to-bottom:
 *   1. Master on/off toggle (`userMemoryEnabled` preference). When off,
 *      every control below is disabled and backend skips scan / extract /
 *      chat memory RAG.
 *   2. Slots-missing banner — when preference is ON but a memory model
 *      slot is still unconfigured.
 *   3. Persistent "running on a hosted provider" indicator when a memory
 *      slot is actively hosted/CLI.
 *   4. Two model pickers (memory generation + memory embedding).
 *   5. Locked-entry opt-in.
 *   6. Memory management card (count + Scan + Manage).
 *
 * No component tests per CLAUDE.md — coverage lives in the
 * `useUserMemory` hook test + the backend.
 */
interface MemoriesSettingsProps {
  /** Opens the shared privacy-consent panel (same one the main gen/embed
   *  slots use) pre-set to "accept" — called when a memory slot save lands
   *  on a hosted/CLI class the user hasn't acknowledged yet. */
  onPrivacyPrompt: () => void
  /** Every preset's per-preset credential registry row — used by the
   *  connected-only provider dropdown (same data as Chat & Image). */
  credentials: ProviderCredential[]
}

export function MemoriesSettings({ onPrivacyPrompt, credentials }: MemoriesSettingsProps) {
  const { t, i18n } = useTranslation('ai')
  const {
    hydrated,
    userMemoryEnabled,
    memoryGen,
    memoryEmbed,
    saveMemoryGenProvider,
    saveMemoryEmbedProvider,
    hydrate,
  } = useAiSettingsStore()
  const memory = useUserMemory()
  const [actionError, setActionError] = useState<string | null>(null)
  /** Scan + tidy in flight — the pass makes provider calls and can take a
   *  while, so both Scan buttons show a running state instead of silence. */
  const [scanning, setScanning] = useState(false)
  const { includeProtected, setIncludeProtected } = useMemoryIncludeProtected()
  const [showProtectedRisk, setShowProtectedRisk] = useState(false)
  const { allowHosted, setAllowHosted } = useMemoryAllowHosted()
  const [memoriesModalOpen, setMemoriesModalOpen] = useState(false)
  const [scanHelpOpen, setScanHelpOpen] = useState(false)
  const scanHelpTriggerRef = useRef<HTMLButtonElement>(null)
  // Full-text filter for the manage-memories modal. Client-side only —
  // `list_memory_items` already returns every live item.
  const [memoriesSearchQuery, setMemoriesSearchQuery] = useState('')
  // Counts how many per-item delete `ConfirmDialog`s are currently open
  // inside the memories modal. The confirm dialog is itself a `<Modal>`
  // nested inside this one — both attach their own document-level Escape
  // listener, so without this guard Escape would close BOTH at once.
  const [openConfirmCount, setOpenConfirmCount] = useState(0)
  const handleConfirmOpenChange = useCallback((open: boolean) => {
    setOpenConfirmCount((count) => count + (open ? 1 : -1))
  }, [])

  const filteredMemoryItems = useMemo(
    () => filterMemoryItemsByQuery(memory.items, memoriesSearchQuery),
    [memory.items, memoriesSearchQuery],
  )
  const hasMemoriesSearch = memoriesSearchQuery.trim().length > 0

  const openMemoriesModal = useCallback(() => {
    setMemoriesSearchQuery('')
    setMemoriesModalOpen(true)
  }, [])

  const closeMemoriesModal = useCallback(() => {
    setMemoriesModalOpen(false)
    setMemoriesSearchQuery('')
  }, [])

  // Hoisted once for both model pickers (same pattern as Chat & Image).
  // Always probe on this tab so switching a draft to Ollama has models ready.
  const ollama = useOllamaInstalledModels(true)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  function handleToggleProtected(next: boolean) {
    if (next) {
      setShowProtectedRisk(true)
      return
    }
    void setIncludeProtected(false)
  }

  async function confirmEnableHosted(): Promise<void> {
    try {
      await setAllowHosted(true)
      await hydrate()
      setActionError(null)
    } catch (e) {
      setActionError(errMsg(e))
      throw e
    }
  }

  async function handleSaveGen(input: AIMemoryGenProviderConfigInput): Promise<void> {
    const result = await saveMemoryGenProvider(input)
    await hydrate()
    setActionError(null)
    if (result.requiresPrivacyConsent) {
      onPrivacyPrompt()
    }
  }

  async function handleSaveEmbed(input: AIMemoryEmbedProviderConfigInput): Promise<void> {
    const result = await saveMemoryEmbedProvider(input)
    await hydrate()
    setActionError(null)
    if (result.requiresPrivacyConsent) {
      onPrivacyPrompt()
    }
  }

  async function handleScan() {
    if (scanning) return
    setScanning(true)
    try {
      await memory.scan()
      setActionError(null)
    } catch (e) {
      setActionError(errMsg(e))
    } finally {
      setScanning(false)
    }
  }

  async function handleMasterToggle(next: boolean) {
    try {
      await setAiFeature('user_memory', next)
      useAiSettingsStore.getState().setFlag('user_memory', next)
      await hydrate()
      setActionError(null)
    } catch (e) {
      setActionError(errMsg(e))
    }
  }

  const genMissing = !memoryGen
  const embedMissing = !memoryEmbed
  /** Both memory model slots configured — required for scan/RAG/persona rebuild. */
  const slotsReady = !genMissing && !embedMissing
  /** Preference on AND slots ready — matches backend `is_user_memory_active`. */
  const memoryActive = userMemoryEnabled && slotsReady

  return (
    <div className="space-y-6">
      {/* ── Memories: header + master toggle + locked opt-in + actions ──
          One group card, sections divided like the Features tab's groups. */}
      <section className="border-border-card divide-border-default divide-y overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-fg text-sm font-semibold">
                {t('user_memory.memories_list_title')}
              </h3>
              <span className="text-xs">
                <span className={memory.items.length === 0 ? 'text-empty-text' : 'text-info-text'}>
                  {t('user_memory.manage_count', { count: memory.items.length })}
                </span>
                {/* Three states. Any successful scan (manual or worker) shows
                    its timestamp via lastScannedAt; hasEverScanned covers the
                    legacy case where only the write-once first-scan marker
                    exists; "never scanned" is reserved for a device with zero
                    local items AND no scan of any kind. Synced-in items without
                    a local scan show the count alone — the first-scan marker
                    stays device-local. Both flags start at their never-scanned
                    value, so the label waits for the load or it flashes that
                    false claim. */}
                {memory.lastScannedAt != null ? (
                  <span className="text-fg-muted">
                    {' · '}
                    {t('user_memory.last_scanned', {
                      when: formatLastScanned(memory.lastScannedAt, i18n.language),
                    })}
                  </span>
                ) : (
                  !memory.loading &&
                  !memory.hasEverScanned &&
                  memory.items.length === 0 && (
                    <span className="text-fg-muted">
                      {' · '}
                      {t('user_memory.never_scanned')}
                    </span>
                  )
                )}
              </span>
            </div>
            <p className="text-fg-muted mt-1 text-xs leading-snug">{t('user_memory.used_by')}</p>
          </div>
          <Toggle
            checked={userMemoryEnabled}
            onChange={(next) => void handleMasterToggle(next)}
            ariaLabel={t('user_memory.master_toggle_title')}
            disabled={!hydrated}
          />
        </div>

        <div
          className={userMemoryEnabled ? 'px-4' : 'pointer-events-none px-4 opacity-50 select-none'}
          aria-disabled={!userMemoryEnabled}
        >
          <SettingsRow
            id="settings-anchor-memory-include-protected"
            title={t('user_memory.protected_title')}
            hint={t('user_memory.protected_description')}
            divider={false}
          >
            <Toggle
              checked={includeProtected}
              onChange={handleToggleProtected}
              ariaLabel={t('user_memory.protected_title')}
              disabled={!userMemoryEnabled}
            />
          </SettingsRow>
          {showProtectedRisk && userMemoryEnabled && (
            <div className="border-border-default bg-surface-hi mb-3 space-y-2 rounded-lg border p-3">
              <p className="text-sm">
                <strong className="text-fg">{t('user_memory.protected_risk_title')}: </strong>
                <span className="text-fg-secondary text-sm">
                  {t(
                    requiresHostedAck(memoryGen?.endpointClass) ||
                      requiresHostedAck(memoryEmbed?.endpointClass)
                      ? 'user_memory.protected_risk_body_hosted_active'
                      : 'user_memory.protected_risk_body',
                  )}
                </span>
              </p>
              <p className="text-sm">
                <strong className="text-fg">{t('user_memory.protected_benefit_title')}: </strong>
                <span className="text-fg-secondary">{t('user_memory.protected_benefit_body')}</span>
              </p>
              <p className="text-fg-muted text-sm">{t('user_memory.protected_read_note')}</p>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="xs" onClick={() => setShowProtectedRisk(false)}>
                  {t('action.forget_cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  onClick={() => {
                    void setIncludeProtected(true)
                    setShowProtectedRisk(false)
                  }}
                >
                  {t('user_memory.protected_confirm_enable')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <button
            ref={scanHelpTriggerRef}
            type="button"
            onClick={() => setScanHelpOpen(true)}
            aria-label={t('user_memory.scan_help.aria')}
            className="text-fg-muted hover:text-accent hover:bg-accent-soft inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none"
          >
            <CircleHelp className="size-4" strokeWidth={1.75} />
          </button>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-3.5" strokeWidth={2} />}
            loading={scanning}
            onClick={() => void handleScan()}
            disabled={!memoryActive || scanning}
          >
            {scanning ? t('user_memory.scan_running') : t('user_memory.scan_button')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openMemoriesModal}
            disabled={!userMemoryEnabled}
          >
            {t('user_memory.manage_button')}
          </Button>
        </div>
      </section>

      <MemoryScanHelpPanel
        open={scanHelpOpen}
        onClose={() => setScanHelpOpen(false)}
        triggerRef={scanHelpTriggerRef}
      />

      {/* Everything below is inert while the master preference is off. */}
      <div
        className={
          userMemoryEnabled ? 'space-y-5' : 'pointer-events-none space-y-5 opacity-50 select-none'
        }
        aria-disabled={!userMemoryEnabled}
      >
        {hydrated && userMemoryEnabled && !slotsReady && (
          <Callout tone="warning" title={t('user_memory.feature_off_title')}>
            <p>{t('user_memory.feature_off_body')}</p>
            <ul className="mt-2 space-y-1">
              {genMissing && <li>• {t('user_memory.slot_missing_gen')}</li>}
              {embedMissing && <li>• {t('user_memory.slot_missing_embed')}</li>}
            </ul>
          </Callout>
        )}

        <div className="space-y-3">
          <div id="settings-anchor-memory-model-gen">
            <MemoryModelsSection
              role="gen"
              config={memoryGen}
              hostedWarning={requiresHostedAck(memoryGen?.endpointClass)}
              onSave={handleSaveGen}
              onError={setActionError}
              allowHosted={allowHosted}
              includeProtected={includeProtected}
              onConfirmAllowHosted={confirmEnableHosted}
              credentials={credentials}
              ollama={ollama}
              disabled={!userMemoryEnabled}
            />
          </div>
          <div id="settings-anchor-memory-model-embed">
            <MemoryModelsSection
              role="embed"
              config={memoryEmbed}
              hostedWarning={requiresHostedAck(memoryEmbed?.endpointClass)}
              onSave={handleSaveEmbed}
              onError={setActionError}
              allowHosted={allowHosted}
              includeProtected={includeProtected}
              onConfirmAllowHosted={confirmEnableHosted}
              credentials={credentials}
              ollama={ollama}
              disabled={!userMemoryEnabled}
            />
          </div>
        </div>

        {actionError && (
          <p className="text-danger-text text-sm" role="alert">
            {actionError}
          </p>
        )}

        {memoriesModalOpen && userMemoryEnabled && (
          <Modal onClose={closeMemoriesModal} disableEsc={openConfirmCount > 0} maxWidth={560}>
            <Modal.Header>
              <span className="inline-flex items-baseline gap-2">
                <span className="font-title text-xl font-semibold">
                  {t('user_memory.memories_list_title')}
                </span>
                <span className="text-fg-muted text-base font-normal tabular-nums">
                  {hasMemoriesSearch
                    ? t('user_memory.search_count', {
                        shown: filteredMemoryItems.length,
                        total: memory.items.length,
                      })
                    : memory.items.length}
                </span>
              </span>
            </Modal.Header>
            {/* Pinned search band as flex sibling under the header (matches ChatSessionList). */}
            <div className="border-border-default bg-surface-hi shrink-0 border-b px-5 py-1.5">
              <div className="relative">
                <Search
                  className="text-fg-muted pointer-events-none absolute top-1/2 left-0 size-4 -translate-y-1/2"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <TextInput
                  type="search"
                  value={memoriesSearchQuery}
                  onChange={setMemoriesSearchQuery}
                  placeholder={t('user_memory.search_placeholder')}
                  aria-label={t('user_memory.search_aria')}
                  className="xj-input-bare h-9 rounded-none border-transparent bg-transparent px-0 py-2 pr-8 pl-6.5 shadow-none hover:border-transparent"
                />
                {hasMemoriesSearch && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<X className="size-3.5" aria-hidden />}
                    onClick={() => setMemoriesSearchQuery('')}
                    aria-label={t('user_memory.clear_search')}
                    className="absolute top-1/2 right-0 size-7! -translate-y-1/2"
                  />
                )}
              </div>
            </div>
            <Modal.Body>
              {memory.loading || memory.items.length === 0 ? (
                <p className="text-fg-muted text-sm">{t('user_memory.empty_state')}</p>
              ) : filteredMemoryItems.length === 0 ? (
                <p className="text-fg-muted text-sm">{t('user_memory.search_empty')}</p>
              ) : (
                <ul className="space-y-2">
                  {filteredMemoryItems.map((item, index) => (
                    <MemoryItemRow
                      key={item.id}
                      index={index + 1}
                      id={item.id}
                      text={item.text}
                      enabled={item.enabled}
                      createdAt={item.createdAt}
                      updatedAt={item.updatedAt}
                      language={i18n.language}
                      onEdit={memory.editText}
                      onToggle={memory.setEnabled}
                      onDelete={memory.remove}
                      onConfirmOpenChange={handleConfirmOpenChange}
                    />
                  ))}
                </ul>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                size="sm"
                className="mr-auto"
                icon={<RefreshCw className="size-3.5" strokeWidth={2} />}
                loading={scanning}
                onClick={() => void handleScan()}
                disabled={!memoryActive || scanning}
              >
                {scanning ? t('user_memory.scan_running') : t('user_memory.scan_button')}
              </Button>
              <Button variant="ghost" size="sm" onClick={closeMemoriesModal}>
                {t('action.close')}
              </Button>
            </Modal.Footer>
          </Modal>
        )}
      </div>
    </div>
  )
}

// ─── Memory models section (mirrors Chat & Image ModelsSection) ─────────────

interface OllamaProbeState {
  models: ReturnType<typeof useOllamaInstalledModels>['models']
  loading: boolean
  unreachable: boolean
}

interface MemoryModelsSectionProps<I> {
  role: 'gen' | 'embed'
  config: AIMemoryGenProviderConfig | AIMemoryEmbedProviderConfig | null
  onSave: (input: I) => Promise<void>
  onError: (msg: string | null) => void
  allowHosted: boolean
  includeProtected: boolean
  onConfirmAllowHosted: () => Promise<void>
  credentials: ProviderCredential[]
  ollama: OllamaProbeState
  /** Slot runs on a hosted/CLI provider — show the raw-content warning icon. */
  hostedWarning: boolean
  /** Master User Memory preference off — freeze controls. */
  disabled?: boolean
}

/**
 * One memory slot: provider + model side by side + Save.
 * Only connected providers appear (same as Chat & Image). Hosted/CLI
 * selections open a confirm modal before the draft updates when
 * `ai_memory_allow_hosted` is still off.
 */
function MemoryModelsSection<
  I extends AIMemoryGenProviderConfigInput | AIMemoryEmbedProviderConfigInput,
>({
  role,
  config,
  onSave,
  onError,
  allowHosted,
  includeProtected,
  onConfirmAllowHosted,
  credentials,
  ollama,
  hostedWarning,
  disabled = false,
}: MemoryModelsSectionProps<I>) {
  const { t } = useTranslation('ai')
  const capability: ProviderCapability = role === 'gen' ? 'chat' : 'embed'
  const isGen = role === 'gen'
  const addedProviders = useUiStore((s) => s.addedProviders)

  const credentialByPreset = useMemo(() => {
    const map = new Map<string, ProviderCredential>()
    for (const c of credentials) map.set(c.presetId, c)
    return map
  }, [credentials])

  // Same endpoint-class resolution as the previous MemoryProviderCard —
  // used only for the hosted-ack gate when the user picks a provider.
  const endpointClassFor = useCallback(
    (presetId: string): EndpointClass => {
      const stored = credentialByPreset.get(presetId)?.endpointClass
      if (stored) return stored
      if (providerUsesSubprocess(presetId)) return 'subscription'
      const group = getPreset(presetId)?.group
      if (group === 'hosted' && presetId !== 'custom' && presetId !== 'other-local') return 'remote'
      return 'local'
    },
    [credentialByPreset],
  )

  const [presetId, setPresetId] = useState(() => defaultPresetIdFor(capability))
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [pendingHostedPresetId, setPendingHostedPresetId] = useState<string | null>(null)
  const savingRef = useRef(false)

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

  useEffect(() => {
    if (savingRef.current) return
    if (!config) {
      const preset = getPreset(defaultPresetIdFor(capability))!
      setPresetId(preset.id)
      setModel(isGen ? (preset.chatModel ?? '') : preset.embeddingModel)
      return
    }
    setPresetId(config.provider)
    setModel(
      isGen
        ? (config as AIMemoryGenProviderConfig).chatModel
        : (config as AIMemoryEmbedProviderConfig).embeddingModel,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, capability])

  const preset = useMemo(() => getPreset(presetId) ?? getPreset('custom')!, [presetId])

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

  const isDirty = useMemo(() => {
    if (!config) return true
    if (config.provider !== preset.id) return true
    if (isGen) {
      return (config as AIMemoryGenProviderConfig).chatModel.trim() !== model.trim()
    }
    return (config as AIMemoryEmbedProviderConfig).embeddingModel.trim() !== model.trim()
  }, [config, preset.id, isGen, model])

  function applyPresetChange(id: string, next: ProviderPreset | undefined) {
    setPresetId(id)
    if (!next) return
    const restoringSaved = config != null && config.provider === id
    setModel(
      restoringSaved
        ? isGen
          ? (config as AIMemoryGenProviderConfig).chatModel
          : (config as AIMemoryEmbedProviderConfig).embeddingModel
        : isGen
          ? (next.chatModel ?? '')
          : next.embeddingModel,
    )
  }

  function handlePresetChange(id: string) {
    const next = getPreset(id)
    if (next && requiresHostedAck(endpointClassFor(id)) && !allowHosted) {
      setPendingHostedPresetId(id)
      return
    }
    applyPresetChange(id, next)
  }

  async function confirmPendingHostedPreset(): Promise<void> {
    if (!pendingHostedPresetId) return
    savingRef.current = true
    try {
      await onConfirmAllowHosted()
    } catch {
      savingRef.current = false
      return
    }
    applyPresetChange(pendingHostedPresetId, getPreset(pendingHostedPresetId))
    setPendingHostedPresetId(null)
    savingRef.current = false
  }

  async function handleSave() {
    setSaving(true)
    savingRef.current = true
    try {
      const input = (
        isGen
          ? { provider: preset.id, chatModel: model.trim() }
          : { provider: preset.id, embeddingModel: model.trim() }
      ) as I
      await onSave(input)
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    } finally {
      setSaving(false)
      queueMicrotask(() => {
        savingRef.current = false
      })
    }
  }

  const sectionTitle = isGen
    ? t('user_memory.memory_gen_model_label')
    : t('user_memory.memory_embed_model_label')

  const isOllama = preset.id === 'ollama'
  const modelField = providerIsOnDevice(preset.id) ? (
    isGen ? (
      <OnDeviceModelField
        label={sectionTitle}
        value={model}
        onChange={setModel}
        readyModels={readyChatModels.map((m) => ({ id: m.id, label: m.display_name }))}
        providersPresetId="on-device-llm"
        disabled={disabled}
      />
    ) : (
      <OnDeviceModelField
        label={sectionTitle}
        value={model}
        onChange={setModel}
        readyModels={readyEmbeddingModels.map((m) => ({ id: m.id, label: m.displayName }))}
        providersPresetId="on-device"
        disabled={disabled}
      />
    )
  ) : (
    <ModelField
      label={sectionTitle}
      value={model}
      onChange={setModel}
      suggestions={
        isOllama
          ? undefined
          : isGen
            ? preset.chatModelSuggestions
            : preset.embeddingModelSuggestions
      }
      installed={isOllama ? (isGen ? installedChatModels : installedEmbeddingModels) : undefined}
      disabled={disabled}
    />
  )

  // Provider-reachability notice. Rendered as its own full-width row under the
  // whole provider/model/save group rather than tucked under the model
  // dropdown: it is about the PROVIDER being unreachable, not about the model
  // field, and the narrow column wrapped it into an unreadable sliver.
  const showOllamaUnreachable = isOllama && ollama.unreachable && !ollama.loading

  const providerOptions = useMemo(
    () =>
      buildConnectedProviderOptions(
        capability,
        credentialByPreset,
        addedProviders,
        {
          embed: readyEmbeddingModels.length > 0,
          llm: readyChatModels.length > 0,
        },
        presetId,
      ),
    [
      capability,
      credentialByPreset,
      addedProviders,
      readyEmbeddingModels.length,
      readyChatModels.length,
      presetId,
    ],
  )

  return (
    <section className="border-border-card bg-surface-hi space-y-3 overflow-hidden rounded-2xl border p-4">
      <div className="flex items-center gap-1.5">
        <h3 className="text-fg text-sm font-semibold">{sectionTitle}</h3>
        {hostedWarning && (
          <Tooltip content={t('user_memory.hosted_active_indicator')} multiline placement="top">
            <button
              type="button"
              aria-label={t('user_memory.hosted_active_indicator')}
              className="text-warning hover:text-warning-text inline-flex cursor-help items-center rounded-full outline-none"
            >
              <AlertTriangle className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-2">
              <Select
                className="px-3 py-2.5"
                value={presetId}
                onChange={handlePresetChange}
                options={providerOptions}
                aria-label={t('section.provider')}
                disabled={disabled}
              />
            </div>
            <div className="min-w-0 flex-3">{modelField}</div>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          loading={saving}
          onClick={() => void handleSave()}
          disabled={disabled || saving || !isDirty}
          title={
            !isDirty
              ? t('action.save_no_changes', { defaultValue: 'No unsaved changes' })
              : undefined
          }
        >
          {saving ? t('action.saving') : t('action.save')}
        </Button>
      </div>

      {isGen && (
        <p className="text-fg-muted text-xs leading-relaxed">
          {t('user_memory.gen_model_quality_hint')}
        </p>
      )}

      {showOllamaUnreachable && (
        <p className="text-empty-text text-xs leading-relaxed">{t('models.ollama_unreachable')}</p>
      )}

      {pendingHostedPresetId != null && (
        <HostedMemoryConfirmModal
          onCancel={() => setPendingHostedPresetId(null)}
          onConfirm={confirmPendingHostedPreset}
          includeProtected={includeProtected}
        />
      )}
    </section>
  )
}

function defaultPresetIdFor(cap: ProviderCapability): string {
  const capable = getPresetsByCapability(cap)
  return capable.find((p) => p.group === 'local')?.id ?? capable[0]?.id ?? 'ollama'
}

// ─── Model field helpers (mirrors AISettingsPanel) ──────────────────────────

function ModelField({
  label,
  value,
  onChange,
  suggestions,
  installed,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  suggestions?: ModelSuggestion[]
  installed?: ComboBoxOption[]
  disabled?: boolean
}) {
  const { t } = useTranslation('ai')
  const options = useMemo<ComboBoxOption[]>(
    () =>
      buildModelOptions(installed, suggestions, {
        installed: t('models.badge_installed'),
        recommended: t('models.badge_recommended'),
      }),
    [installed, suggestions, t],
  )

  return (
    <div className="min-w-0 flex-1">
      {options.length > 0 ? (
        <ComboBox
          value={value}
          onChange={onChange}
          options={options}
          className="px-3 py-2.5"
          aria-label={label}
          disabled={disabled}
        />
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          className="font-mono"
          aria-label={label}
          disabled={disabled}
        />
      )}
    </div>
  )
}

function OnDeviceModelField({
  label,
  value,
  onChange,
  readyModels,
  providersPresetId,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  readyModels: { id: string; label: string }[]
  providersPresetId: string
  disabled?: boolean
}) {
  const { t } = useTranslation('ai')
  const setPendingOpenPresetId = useUiStore((s) => s.setPendingOpenPresetId)

  if (readyModels.length === 0) {
    return (
      <div className="min-w-0 flex-1 text-sm">
        <span className="text-fg-muted">{t('field.on_device_no_models')}</span>{' '}
        <button
          type="button"
          className="text-accent hover:text-accent-hover underline"
          disabled={disabled}
          onClick={() => {
            useTabStore.getState().updateActiveTab({ aiTab: 'providers' })
            setPendingOpenPresetId(providersPresetId)
          }}
        >
          {t('field.on_device_no_models_link')}
        </button>
      </div>
    )
  }

  const options: SelectOption[] = readyModels.map((m) => ({ value: m.id, label: m.label }))
  return (
    <div className="min-w-0 flex-1">
      <Select
        value={value}
        onChange={onChange}
        options={options}
        aria-label={label}
        disabled={disabled}
      />
    </div>
  )
}

// ─── Persona summary + manage modal ─────────────────────────────────────────

// ─── Hosted/CLI acknowledgement modal ───────────────────────────────────────

interface HostedMemoryConfirmModalProps {
  onCancel: () => void
  onConfirm: () => Promise<void>
  /** Current `ai_memory_include_protected` value — composes into the
   *  disclosure copy when locked entries are already included. */
  includeProtected: boolean
}

/** Confirmation modal when the user picks a hosted/CLI provider for a
 *  memory slot while `ai_memory_allow_hosted` is still off. Confirming
 *  sets the flag and applies the pending selection; cancelling leaves
 *  the previous selection untouched. */
function HostedMemoryConfirmModal({
  onCancel,
  onConfirm,
  includeProtected,
}: HostedMemoryConfirmModalProps) {
  const { t } = useTranslation('ai')
  const [confirming, setConfirming] = useState(false)

  async function handleConfirm() {
    setConfirming(true)
    try {
      await onConfirm()
    } catch {
      // Caller surfaces the error — swallow so the rejection isn't unhandled.
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Modal onClose={onCancel} maxWidth={480}>
      <Modal.Header
        description={t(
          includeProtected
            ? 'user_memory.hosted_confirm_body_protected_active'
            : 'user_memory.hosted_confirm_body',
        )}
      >
        {t('user_memory.hosted_confirm_title')}
      </Modal.Header>
      <Modal.Body>
        <p className="text-fg-muted text-xs leading-relaxed">
          {t('user_memory.hosted_confirm_footer')}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('action.forget_cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={confirming}
          onClick={() => void handleConfirm()}
        >
          {t('user_memory.hosted_confirm_confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// ─── MemoryItemRow ───────────────────────────────────────────────────────────

interface MemoryItemRowProps {
  /** 1-based position in the list (shown dimmed before the memory text). */
  index: number
  id: string
  text: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  language: string
  onEdit: (id: string, text: string) => Promise<void>
  onToggle: (id: string, enabled: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onConfirmOpenChange?: (open: boolean) => void
}

const UPDATED_MEANINGFUL_GAP_SECONDS = 60

function MemoryItemRow({
  index,
  id,
  text,
  enabled,
  createdAt,
  updatedAt,
  language,
  onEdit,
  onToggle,
  onDelete,
  onConfirmOpenChange,
}: MemoryItemRowProps) {
  const { t } = useTranslation('ai')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    onConfirmOpenChange?.(confirmOpen)
    return () => {
      if (confirmOpen) onConfirmOpenChange?.(false)
    }
  }, [confirmOpen, onConfirmOpenChange])

  function startEdit() {
    setDraft(text)
    setEditError(null)
    setEditing(true)
  }

  async function handleSaveEdit() {
    const next = draft.trim()
    if (!next) return
    setSaving(true)
    try {
      await onEdit(id, next)
      setEditing(false)
      setEditError(null)
    } catch (e) {
      setEditError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  const createdLabel = t('user_memory.created_at', {
    when: formatLastScanned(createdAt, language),
  })
  const updatedLabel =
    updatedAt - createdAt >= UPDATED_MEANINGFUL_GAP_SECONDS
      ? t('user_memory.updated_at', {
          when: formatLastScanned(updatedAt, language),
        })
      : null

  return (
    <li className="border-border-default bg-surface-hi rounded-lg border p-3">
      {editing ? (
        <div className="flex items-start gap-3">
          <span
            className="text-fg-muted w-5 shrink-0 pt-2 text-right text-sm tabular-nums"
            aria-hidden
          >
            {index}
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <TextInput
              multiline
              rows={3}
              value={draft}
              onChange={setDraft}
              aria-label={t('user_memory.memory_text_label')}
              placeholder={t('user_memory.edit_memory_placeholder')}
              className="resize-y"
            />
            {editError && (
              <p className="text-danger-text text-xs" role="alert">
                {editError}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="xs"
                loading={saving}
                onClick={() => void handleSaveEdit()}
              >
                {t('action.save')}
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setEditing(false)} disabled={saving}>
                {t('action.forget_cancel')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <span
            className="text-fg-muted w-5 shrink-0 text-right text-sm leading-relaxed tabular-nums"
            aria-hidden
          >
            {index}
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={
                enabled
                  ? 'text-fg text-sm leading-relaxed whitespace-pre-wrap'
                  : 'text-fg-muted text-sm leading-relaxed whitespace-pre-wrap line-through'
              }
            >
              {text}
            </p>
            <p className="text-fg-muted mt-1 text-xs">
              {createdLabel}
              {updatedLabel != null && <> · {updatedLabel}</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip content={t('user_memory.edit')} placement="top">
              <Button
                variant="ghost"
                size="xs"
                icon={<Pencil className="size-3.5" />}
                onClick={startEdit}
                aria-label={t('user_memory.edit')}
              />
            </Tooltip>
            <Tooltip
              content={enabled ? t('user_memory.disable') : t('user_memory.enable')}
              placement="top"
            >
              <Button
                variant="ghost"
                size="xs"
                icon={<Brain className={enabled ? 'text-accent size-3.5' : 'size-3.5'} />}
                onClick={() => void onToggle(id, !enabled)}
                aria-label={enabled ? t('user_memory.disable') : t('user_memory.enable')}
              />
            </Tooltip>
            <Tooltip content={t('user_memory.delete')} placement="top">
              <Button
                variant="ghost"
                size="xs"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => setConfirmOpen(true)}
                aria-label={t('user_memory.delete')}
              />
            </Tooltip>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={t('user_memory.delete')}
        description={t('user_memory.delete_confirm')}
        confirmLabel={t('user_memory.delete')}
        onConfirm={() => onDelete(id)}
        onClose={() => setConfirmOpen(false)}
      />
    </li>
  )
}
