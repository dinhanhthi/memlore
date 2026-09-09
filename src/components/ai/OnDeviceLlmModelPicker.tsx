import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertCircle,
  AlertTriangle,
  Brackets,
  CheckCircle2,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  MemoryStick,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TermsNotAcceptedError,
  useOnDeviceLlmModels,
  type LlmModelState,
  type LlmServerState,
  type OnDeviceLlmCatalogEntry,
} from '../../hooks/useOnDeviceLlmModels'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Modal } from '../common/Modal'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'

interface OnDeviceLlmModelPickerProps {
  /** The catalog id currently selected as the chat model for the
   *  generation slot, or `null` when the slot isn't on-device / isn't
   *  configured yet. Drives the radio-style "selected" affordance. */
  currentChatModelId: string | null
  /** Persist the generation slot's chat model as `modelId`. The parent
   *  wires this to `saveGeneration` (provider `on-device-llm`, no
   *  endpoint, no apiKey) — this component never calls `invoke()` directly. */
  onSelectChatModel: (modelId: string) => void
  /** Tear down the generation slot before deleting the active model.
   *  Parent wires this to `forgetGeneration` from `useAIProviderConfig`
   *  so the settings snapshot refreshes — this component never calls
   *  `invoke()` directly. Deleting the selected model is allowed. */
  forgetGeneration: () => Promise<void>
  /** When `false`, omit the section blurb (e.g. modal already shows it in
   *  the header). Defaults to `true` for inline Settings embeddings. */
  showDescription?: boolean
}

/**
 * On-device LLM chat model catalog + download/select/delete UI (Phase 5
 * Task 2).
 *
 * Mirrors the embedding `OnDeviceModelPicker`'s composition but adds two
 * on-device-LLM-specific surfaces:
 *  - A server-status line (llama-server lifecycle: stopped / starting /
 *    ready / failed). This is an in-panel status hint for context; the
 *    dedicated footer chip (Task 4) is the always-visible indicator.
 *  - A binary-download indicator — the llama-server sidecar binary must
 *    download once (JIT) before any model can run. `binaryState` is fed
 *    by the `BINARY_PHASE_ID`-tagged progress events.
 *
 * Data comes entirely from `useOnDeviceLlmModels`, which hydrates from
 * `list_on_device_llm_models` + `get_on_device_llm_server_status` and
 * subscribes to the `on-device-llm:download-progress` /
 * `on-device-llm:server-status` Tauri events. Components never call
 * `invoke()` directly.
 *
 * All strings are localized (`ai` namespace, `on_device_llm.*` keys) with
 * inline `defaultValue`s (Task 5).
 */
export function OnDeviceLlmModelPicker({
  currentChatModelId,
  onSelectChatModel,
  forgetGeneration,
  showDescription = true,
}: OnDeviceLlmModelPickerProps) {
  const { t } = useTranslation('ai')
  const {
    catalog,
    states,
    binaryState,
    serverStatus,
    download,
    cancelDownload,
    remove,
    termsAccepted,
    acceptTerms,
  } = useOnDeviceLlmModels()
  const [termsModalEntry, setTermsModalEntry] = useState<OnDeviceLlmCatalogEntry | null>(null)
  const [acceptingTerms, setAcceptingTerms] = useState(false)

  function requestDownload(entry: OnDeviceLlmCatalogEntry) {
    if (entry.requires_acceptance && !termsAccepted) {
      setTermsModalEntry(entry)
      return
    }
    void download(entry.id).catch((e) => {
      if (e instanceof TermsNotAcceptedError) {
        setTermsModalEntry(entry)
      }
    })
  }

  async function handleAcceptTerms() {
    const entry = termsModalEntry
    if (!entry || acceptingTerms) return
    setAcceptingTerms(true)
    try {
      await acceptTerms()
      setTermsModalEntry(null)
      void download(entry.id)
    } catch (e) {
      console.warn('OnDeviceLlmModelPicker: acceptTerms failed', e)
    } finally {
      setAcceptingTerms(false)
    }
  }

  function handleTermsLink(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    const url = termsModalEntry?.terms_url
    if (url) void openUrl(url)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showDescription && (
        <p className="text-fg-muted shrink-0 text-sm leading-relaxed">
          {t('on_device_llm.section_description', {
            defaultValue: 'Download once, then chat fully offline on this device.',
          })}
        </p>
      )}

      {/* Binary DOWNLOAD progress is intentionally NOT shown here — it lives
          on the always-visible footer chip ("Downloading engine… N%"), so an
          in-panel box would only duplicate it and flicker as the (small,
          fast) binary fetch completes. We still surface a binary-phase ERROR
          below, since that otherwise disappears silently and leaves every
          model's optimistic "Downloading 0%" stuck with no explanation. */}
      {binaryState.status === 'error' && (
        <div className="bg-panel-2 border-border-default mt-3 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <AlertCircle className="text-danger size-3.5 shrink-0" />
          <span className="text-danger-text">
            {t('on_device_llm.binary_failed', {
              defaultValue: 'On-device engine download failed',
            })}
          </span>
          {binaryState.code && (
            <span className="text-fg-muted text-2xs ml-auto font-mono">({binaryState.code})</span>
          )}
        </div>
      )}

      <div className="shrink-0">
        <ServerStatusLine state={serverStatus.state} code={serverStatus.code} />
      </div>

      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto">
        {catalog.map((entry) => (
          <LlmModelCard
            key={entry.id}
            entry={entry}
            state={states[entry.id] ?? { status: 'not_downloaded' }}
            isCurrent={entry.id === currentChatModelId}
            onDownload={() => requestDownload(entry)}
            onCancel={() => void cancelDownload(entry.id)}
            onRetry={() => requestDownload(entry)}
            onRemove={() => remove(entry.id)}
            onSelect={() => onSelectChatModel(entry.id)}
            forgetGeneration={forgetGeneration}
          />
        ))}
      </div>

      {termsModalEntry && (
        <Modal onClose={() => !acceptingTerms && setTermsModalEntry(null)}>
          <Modal.Header>
            {t('on_device_llm.terms.title', { defaultValue: 'Gemma Terms of Use' })}
          </Modal.Header>
          <Modal.Body fitContent>
            <p className="text-fg-secondary text-sm leading-relaxed">
              {t('on_device_llm.terms.summary', {
                defaultValue:
                  "Gemma models are licensed under Google's Gemma Terms of Use. You must accept these terms before downloading a model to this device. Memlore stores a local acceptance receipt; it is not synced.",
              })}
            </p>
            {termsModalEntry.terms_url && (
              <a
                href={termsModalEntry.terms_url}
                onClick={handleTermsLink}
                className="text-accent mt-3 inline-flex items-center gap-1.5 text-sm underline-offset-2 hover:underline"
              >
                {t('on_device_llm.terms.link_label', {
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
              onClick={() => setTermsModalEntry(null)}
              disabled={acceptingTerms}
            >
              {t('on_device_llm.terms.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button size="sm" onClick={() => void handleAcceptTerms()} disabled={acceptingTerms}>
              {t('on_device_llm.terms.accept', { defaultValue: 'Accept' })}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}

function LlmModelCard({
  entry,
  state,
  isCurrent,
  onDownload,
  onCancel,
  onRetry,
  onRemove,
  onSelect,
  forgetGeneration,
}: {
  entry: OnDeviceLlmCatalogEntry
  state: LlmModelState
  isCurrent: boolean
  onDownload: () => void
  onCancel: () => void
  onRetry: () => void
  onRemove: () => Promise<void>
  onSelect: () => void
  forgetGeneration: () => Promise<void>
}) {
  const { t } = useTranslation('ai')
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  // Surfaces a failed delete inline next to the Delete control. Cleared on
  // the next delete attempt. Deleting the active model is allowed: we
  // forget the generation slot first, so `"model_in_use"` is not mapped.
  const [removeError, setRemoveError] = useState<string | null>(null)

  // Per-model catalog blurbs are localized the same way as the sibling
  // embedding `OnDeviceModelPicker` (`on_device_models.models.<id>.*`):
  // keyed by catalog id, with the backend's English copy as `defaultValue`
  // so a model added to the catalog before its translation lands still
  // renders something.
  const modelKey = `on_device_llm.models.${entry.id}`
  const displayName = t(`${modelKey}.display_name`, { defaultValue: entry.display_name })
  const whenToChoose = t(`${modelKey}.when_to_choose`, { defaultValue: entry.when_to_choose })
  const sizeGb = (entry.download_size_bytes / 1e9).toFixed(1)

  async function handleRemove() {
    setRemoveError(null)
    try {
      if (isCurrent) await forgetGeneration()
      await onRemove()
      setConfirmRemoveOpen(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRemoveError(msg)
      // This catch swallows the rejection, so the promise `handleRemove`
      // returns to `ConfirmDialog` always resolves — its `.then(onClose)`
      // still fires and the dialog closes even though the delete failed.
      // The error then surfaces via the row-level block below; `onClose`
      // deliberately does NOT reset `removeError`, so this message survives
      // the auto-close. It is cleared on the next Delete-button open and at
      // the start of the next `handleRemove` attempt.
    }
  }

  // "Selected" is a READY affordance, not just "the configured chat model
  // id" — the generation slot auto-saves the recommended model id before
  // it's ever downloaded, so gating on `isCurrent` alone would show
  // "Selected" for a model that isn't actually usable yet.
  const isSelected = isCurrent && state.status === 'ready'

  // Selected rows get the primary gradient border; unselected rows use the
  // default subtle border. See globals.css `gradient-border-primary` notes:
  // the class MUST coexist with a `border border-transparent` so the
  // gradient's `::before` mask renders (tailwind-merge would strip a
  // `border-gradient-*` name, hence the `gradient-*` prefix).
  const rowBorder = isSelected
    ? 'gradient-border-primary border border-transparent [--border-gradient-width:2px]'
    : 'border-border-default border'

  const showFooterActions =
    state.status === 'not_downloaded' ||
    state.status === 'downloading' ||
    state.status === 'error' ||
    state.status === 'ready'

  return (
    <div className={`rounded-lg p-3 ${rowBorder}`}>
      <div className="min-w-0">
        {/* Single-line title: name truncates; badges stay visible. */}
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="text-fg min-w-0 truncate text-sm font-semibold">{displayName}</h4>
          <div className="flex shrink-0 items-center gap-1.5">
            {entry.recommended && (
              <span className="bg-accent-soft text-accent-text rounded-full px-2 py-0.5 text-xs font-medium">
                {t('on_device_llm.recommended_badge', { defaultValue: 'Recommended' })}
              </span>
            )}
            {state.status === 'ready' && (
              <span className="bg-success/15 text-success-text rounded-full px-2 py-0.5 text-xs font-medium">
                {t('on_device_llm.ready_badge', { defaultValue: 'Ready' })}
              </span>
            )}
            {isSelected && (
              <span className="text-success inline-flex items-center gap-1 text-xs font-medium">
                <CheckCircle2 className="size-3.5 shrink-0" />
                {t('on_device_llm.selected', { defaultValue: 'Selected' })}
              </span>
            )}
          </div>
        </div>

        <p className="text-fg-muted mt-1 text-xs leading-relaxed">{whenToChoose}</p>

        <div className="text-fg-secondary mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <SpecIconItem
            icon={HardDrive}
            label={t('on_device_llm.download_size_label', { defaultValue: 'Size' })}
            value={`${sizeGb} GB`}
          />
          <SpecIconItem
            icon={MemoryStick}
            label={t('on_device_llm.min_ram_label', { defaultValue: 'Min. RAM' })}
            value={`${entry.min_ram_gb} GB`}
          />
          <SpecIconItem
            icon={Brackets}
            label={t('on_device_llm.context_label', { defaultValue: 'Context' })}
            value={entry.context_tokens.toLocaleString()}
          />
          <div className="flex items-center gap-1 leading-none">
            <Globe className="text-fg-muted size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {entry.multilingual
                ? t('on_device_llm.multilingual_yes', { defaultValue: 'Multilingual' })
                : t('on_device_llm.multilingual_no', { defaultValue: 'Single-language' })}
            </span>
          </div>
        </div>
      </div>

      <LlmModelStatus state={state} />

      {/* Inline delete error — shown above the footer actions so it stays
          next to the Delete control that triggered it. */}
      {removeError && (
        <p className="text-danger-text mt-2 flex items-start gap-1.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="wrap-break-word">{removeError}</span>
        </p>
      )}

      {showFooterActions && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {state.status === 'not_downloaded' && (
            <Button
              variant="secondary"
              size="xs"
              icon={<Download className="size-3.5" strokeWidth={2} />}
              onClick={onDownload}
            >
              {t('on_device_llm.action_download', { defaultValue: 'Download' })}
            </Button>
          )}
          {state.status === 'downloading' && (
            <Button
              variant="secondary"
              size="xs"
              icon={<AlertCircle className="size-3.5" strokeWidth={2} />}
              onClick={onCancel}
            >
              {t('on_device_llm.action_cancel', { defaultValue: 'Cancel' })}
            </Button>
          )}
          {state.status === 'error' && (
            <Button
              variant="secondary"
              size="xs"
              icon={<RotateCcw className="size-3.5" strokeWidth={2} />}
              onClick={onRetry}
            >
              {t('on_device_llm.action_retry', { defaultValue: 'Retry' })}
            </Button>
          )}
          {state.status === 'ready' && (
            <>
              <Button
                variant="secondary"
                size="xs"
                icon={<Trash2 className="size-3.5" strokeWidth={2} />}
                onClick={() => {
                  setRemoveError(null)
                  setConfirmRemoveOpen(true)
                }}
              >
                {t('on_device_llm.action_delete', { defaultValue: 'Delete' })}
              </Button>
              {!isSelected && (
                <Button variant="primary" size="xs" onClick={onSelect}>
                  {t('on_device_llm.action_select', { defaultValue: 'Select' })}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemoveOpen}
        title={t('on_device_llm.delete_confirm_title', {
          defaultValue: 'Delete "{{name}}"?',
          name: displayName,
        })}
        description={
          isCurrent
            ? t('on_device_llm.delete_confirm_description_active', {
                defaultValue:
                  '{{name}} is your active on-device chat model. Deleting it removes it from this device and stops on-device chat until you download it again or pick another model.',
                name: displayName,
              })
            : t('on_device_llm.delete_confirm_description', {
                defaultValue:
                  'This removes the downloaded model files from your device. You can download it again later.',
                name: displayName,
              })
        }
        confirmLabel={t('on_device_llm.action_delete', { defaultValue: 'Delete' })}
        onConfirm={handleRemove}
        onClose={() => {
          // Do NOT reset `removeError` here — on a failed delete the catch in
          // `handleRemove` sets it and `ConfirmDialog` fires this `onClose`
          // right after, so clearing it would wipe the message before it can
          // render. Staleness is handled at the next Delete-open / attempt.
          setConfirmRemoveOpen(false)
        }}
      />
    </div>
  )
}

/** Icon + value pair for model specs (size / RAM / context). Label lives on
 *  the icon via tooltip + aria-label so the row stays compact. */
function SpecIconItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof HardDrive
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-1 leading-none">
      <Tooltip content={label} placement="top">
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center"
          aria-label={label}
        >
          <Icon className="text-fg-muted size-3.5" aria-hidden="true" />
        </span>
      </Tooltip>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

/** Per-model download status line. `downloading` shows a live progress bar
 *  (width transition disabled under reduced-motion); `ready` is a title-row
 *  badge; `error` shows the backend error code. */
function LlmModelStatus({ state }: { state: LlmModelState }) {
  const { t } = useTranslation('ai')

  // Download button in the card footer already signals "not downloaded".
  if (state.status === 'not_downloaded') return null

  if (state.status === 'downloading') {
    const percent = Math.round(state.progress ?? 0)
    return (
      <div className="mt-3">
        <p className="text-accent flex items-center gap-1.5 text-xs">
          <InlineOrb state="searching" aria-hidden />
          <span className="font-medium">
            {t('on_device_llm.status_downloading', {
              defaultValue: 'Downloading… {{percent}}%',
              percent,
            })}
          </span>
        </p>
        <div className="bg-fg-muted/20 mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="bg-accent h-full transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
    )
  }

  // Ready is a title-row badge — no status line.
  if (state.status === 'ready') return null

  if (state.status === 'error') {
    return (
      <p className="text-danger-text mt-3 flex items-center gap-1.5 text-xs wrap-break-word">
        <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
        {t('on_device_llm.status_error', {
          defaultValue: 'Download failed',
        })}
        {state.code && <span className="text-fg-muted text-2xs font-mono">({state.code})</span>}
      </p>
    )
  }

  return null
}

/** Subtle one-line server lifecycle hint for in-panel context. */
function ServerStatusLine({ state, code }: { state: LlmServerState; code?: string }) {
  const { t } = useTranslation('ai')

  // Don't render anything for the default `stopped` state — the engine only
  // spins up on first chat, so a permanent "stopped" line would be noise.
  if (state === 'stopped') return null

  const config: Record<
    Exclude<LlmServerState, 'stopped'>,
    { dot: string; label: string; defaultLabel: string }
  > = {
    starting: {
      dot: 'bg-warning',
      label: 'on_device_llm.server_starting',
      defaultLabel: 'Starting on-device engine…',
    },
    ready: {
      dot: 'bg-success',
      label: 'on_device_llm.server_ready',
      defaultLabel: 'On-device engine ready',
    },
    failed: {
      dot: 'bg-danger',
      label: 'on_device_llm.server_failed',
      defaultLabel: 'On-device engine failed to start',
    },
  }
  const cfg = config[state]

  return (
    <div className="text-fg-muted mt-3 flex items-center gap-1.5 text-xs">
      <span className={cnDot(cfg.dot, state === 'starting')} aria-hidden="true" />
      <span>{t(cfg.label, { defaultValue: cfg.defaultLabel })}</span>
      {state === 'failed' && code && (
        <Tooltip content={code} multiline placement="top">
          <button
            type="button"
            aria-label={t('on_device_llm.error_code_aria', { defaultValue: 'Error code' })}
            className="text-fg-muted hover:text-fg inline-flex cursor-help items-center rounded-full outline-none"
          >
            <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** Status dot class; adds a subtle pulse only for the `starting` state,
 *  disabled under reduced-motion. */
function cnDot(base: string, pulse: boolean): string {
  if (!pulse) return `size-2 shrink-0 rounded-full ${base}`
  return `size-2 shrink-0 rounded-full ${base} animate-pulse motion-reduce:animate-none`
}
