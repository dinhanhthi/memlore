import {
  AlertTriangle,
  Brackets,
  CheckCircle2,
  Download,
  Globe,
  HardDrive,
  MemoryStick,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isHighRamModel,
  useOnDeviceModels,
  type ModelDownloadState,
  type OnDeviceModelCatalogEntry,
} from '../../hooks/useOnDeviceModels'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { InlineOrb } from '../common/ThinkingOrb'
import { ShimmerText } from '../common/ShimmerText'
import { Tooltip } from '../common/Tooltip'

interface OnDeviceModelPickerProps {
  /** The model id currently active for the embedding slot, or `null` when
   *  the embedding slot isn't on-device / isn't configured yet. */
  currentModelId: string | null
  /** Switch the embedding slot to use `modelId` (a READY, already-downloaded
   *  model). The parent wires this to `saveEmbedding` from
   *  `useAIProviderConfig`, which persists and refreshes the slot config —
   *  this component never calls `invoke()` directly. */
  onUseForEmbedding: (modelId: string) => void
  /** When removing the active model, run this first so the embedding slot
   *  snapshot refreshes. Parent wires `forgetEmbedding` from
   *  `useAIProviderConfig` — this component never calls `invoke()`. */
  onBeforeRemoveCurrent?: () => Promise<void>
  /** When `false`, omit the section blurb (e.g. modal already shows it in
   *  the header). Defaults to `true` for inline Settings embeddings. */
  showDescription?: boolean
}

/**
 * On-device embedding model catalog + download UI (Phase 3 Task 8, wired to
 * the real backend in Phase 4 Task 5).
 *
 * Renders inside `AISettingsPanel`'s Embedding tab, gated behind the
 * on-device provider condition (see the call site). Data comes from
 * `useOnDeviceModels`, which loads the catalog's live download state from
 * `list_on_device_models` and drives downloads through the real
 * `start_on_device_model_download` command, updated live via the
 * `ai:model-download-progress` / `ai:model-download-error` events.
 */
export function OnDeviceModelPicker({
  currentModelId,
  onUseForEmbedding,
  onBeforeRemoveCurrent,
  showDescription = true,
}: OnDeviceModelPickerProps) {
  const { t } = useTranslation('ai')
  const { catalog, states, download, retry, remove } = useOnDeviceModels(currentModelId)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showDescription && (
        <p className="text-fg-muted shrink-0 text-sm leading-relaxed">
          {t('on_device_models.section_description')}
        </p>
      )}

      <div className={`min-h-0 flex-1 space-y-3 overflow-y-auto ${showDescription ? 'mt-3' : ''}`}>
        {catalog.map((entry) => (
          <ModelCard
            key={entry.id}
            entry={entry}
            state={states[entry.id] ?? { status: 'not_downloaded' }}
            isCurrent={entry.id === currentModelId}
            onDownload={() => download(entry.id)}
            onRetry={() => retry(entry.id)}
            onRemove={() => remove(entry.id)}
            onUseForEmbedding={() => onUseForEmbedding(entry.id)}
            onBeforeRemoveCurrent={onBeforeRemoveCurrent}
          />
        ))}
      </div>
    </div>
  )
}

function ModelCard({
  entry,
  state,
  isCurrent,
  onDownload,
  onRetry,
  onRemove,
  onUseForEmbedding,
  onBeforeRemoveCurrent,
}: {
  entry: OnDeviceModelCatalogEntry
  state: ModelDownloadState
  isCurrent: boolean
  onDownload: () => void
  onRetry: () => void
  onRemove: () => Promise<void>
  onUseForEmbedding: () => void
  onBeforeRemoveCurrent?: () => Promise<void>
}) {
  const { t } = useTranslation('ai')
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  const modelKey = `on_device_models.models.${entry.id}`
  const displayName = t(`${modelKey}.display_name`, { defaultValue: entry.displayName })
  const whenToChoose = t(`${modelKey}.when_to_choose`, { defaultValue: entry.whenToChoose })
  const downloadSize = t(`${modelKey}.download_size`, { defaultValue: entry.downloadSize })
  const approxRam = t(`${modelKey}.approx_ram`, { defaultValue: entry.approxRam })
  const dimContext = t('on_device_models.dim_context_value', {
    dim: entry.dim,
    ctx: entry.contextLength,
  })

  const showFooterActions =
    state.status === 'not_downloaded' ||
    (state.status === 'error' && state.errorKey !== 'not_supported') ||
    state.status === 'ready'

  return (
    <div className="border-border-default rounded-lg border p-3">
      <div className="min-w-0">
        {/* Single-line title: name truncates; badges stay visible. */}
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="text-fg min-w-0 truncate text-sm font-semibold">{displayName}</h4>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Hardware caution, not a token-cost warning — hence a bare
                tooltip rather than `<UsageWarning>`. */}
            {isHighRamModel(entry) && (
              <Tooltip content={t('on_device_models.high_ram_warning')} multiline placement="top">
                <button
                  type="button"
                  aria-label={t('on_device_models.high_ram_warning')}
                  className="inline-flex cursor-help items-center rounded-full outline-none"
                >
                  <AlertTriangle
                    className="text-warning size-3.5 shrink-0"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                </button>
              </Tooltip>
            )}
            {entry.recommended && (
              <span className="bg-accent-soft text-accent-text rounded-full px-2 py-0.5 text-xs font-medium">
                {t('on_device_models.recommended_badge')}
              </span>
            )}
            {state.status === 'ready' && (
              <span className="bg-success/15 text-success-text rounded-full px-2 py-0.5 text-xs font-medium">
                {t('on_device_models.ready_badge')}
              </span>
            )}
            {isCurrent && (
              <span className="text-success inline-flex items-center gap-1 text-xs font-medium">
                <CheckCircle2 className="size-3.5 shrink-0" />
                {t('on_device_models.current_model')}
              </span>
            )}
          </div>
        </div>

        <p className="text-fg-muted mt-1 text-xs leading-relaxed">{whenToChoose}</p>

        <div className="text-fg-secondary mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <SpecIconItem
            icon={HardDrive}
            label={t('on_device_models.download_size_label')}
            value={downloadSize}
          />
          <SpecIconItem
            icon={MemoryStick}
            label={t('on_device_models.approx_ram_label')}
            value={approxRam}
          />
          <SpecIconItem
            icon={Brackets}
            label={t('on_device_models.dim_context_label')}
            value={dimContext}
          />
          <div className="flex items-center gap-1 leading-none">
            <Globe className="text-fg-muted size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {entry.multilingual
                ? t('on_device_models.multilingual_yes')
                : t('on_device_models.multilingual_no')}
            </span>
          </div>
        </div>
      </div>

      <ModelStatus state={state} />

      {showFooterActions && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {state.status === 'not_downloaded' && (
            <Button
              variant="secondary"
              size="xs"
              icon={<Download className="size-3.5" strokeWidth={2} />}
              onClick={onDownload}
            >
              {t('on_device_models.action_download')}
            </Button>
          )}
          {/* `not_supported` is permanent — no fastembed backend exists for
              this model, so retrying would only repeat the same failure. */}
          {state.status === 'error' && state.errorKey !== 'not_supported' && (
            <Button
              variant="secondary"
              size="xs"
              icon={<RotateCcw className="size-3.5" strokeWidth={2} />}
              onClick={onRetry}
            >
              {t('on_device_models.action_retry')}
            </Button>
          )}
          {state.status === 'ready' && (
            <>
              <Button
                variant="secondary"
                size="xs"
                icon={<Trash2 className="size-3.5" strokeWidth={2} />}
                onClick={() => setConfirmRemoveOpen(true)}
              >
                {t('on_device_models.action_remove')}
              </Button>
              {!isCurrent && (
                <Button variant="primary" size="xs" onClick={onUseForEmbedding}>
                  {t('on_device_models.action_use_for_embedding')}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemoveOpen}
        title={t('on_device_models.remove_confirm_title', { name: displayName })}
        description={
          isCurrent
            ? t('on_device_models.remove_confirm_description_active', { name: displayName })
            : t('on_device_models.remove_confirm_description', { name: displayName })
        }
        confirmLabel={t('on_device_models.action_remove')}
        onConfirm={async () => {
          if (isCurrent) await onBeforeRemoveCurrent?.()
          await onRemove()
        }}
        onClose={() => setConfirmRemoveOpen(false)}
      />
    </div>
  )
}

/** Icon + value pair for model specs (size / RAM / dims). Label lives on the
 *  icon via tooltip + aria-label so the row stays compact. */
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
      <span>{value}</span>
    </div>
  )
}

/** Renders the per-model download status line: downloading (with live
 *  progress from `ai:model-download-progress`) or error. Ready is a
 *  title-row badge; not-downloaded is implied by the Download button.
 *  `not_supported` is a permanent, non-error informational state (no
 *  `fastembed` backend for this model yet) so it renders muted rather
 *  than in the danger color used for real download failures. */
function ModelStatus({ state }: { state: ModelDownloadState }) {
  const { t } = useTranslation('ai')

  // Download button in the card footer already signals "not downloaded".
  if (state.status === 'not_downloaded') return null

  if (state.status === 'downloading') {
    const percent = Math.round(state.progress ?? 0)
    const label =
      state.etaSeconds != null
        ? `${t('on_device_models.status_downloading', { percent })} — ${t('on_device_models.eta', { seconds: state.etaSeconds })}`
        : t('on_device_models.status_downloading', { percent })
    return (
      <div className="mt-3">
        <p className="text-accent flex items-center gap-1.5 text-xs">
          <InlineOrb state="searching" aria-hidden />
          <ShimmerText className="text-xs font-medium">{label}</ShimmerText>
        </p>
        <div className="bg-fg-muted/20 mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="bg-accent h-full transition-[width] duration-300"
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
    const isNotSupported = state.errorKey === 'not_supported'
    return (
      <p
        className={`mt-3 text-xs wrap-break-word ${isNotSupported ? 'text-fg-muted' : 'text-danger-text'}`}
      >
        {/* Known short codes (e.g. `not_supported`) have a localized
            `error_<code>` string; anything else is a raw backend error
            (fastembed/hf_hub chain) shown verbatim so the user sees WHY
            the download failed, not just that it did. */}
        {state.errorKey
          ? t(
              [`on_device_models.error_${state.errorKey}`, 'on_device_models.status_error_detail'],
              { detail: state.errorKey },
            )
          : t('on_device_models.status_error')}
      </p>
    )
  }

  return null
}
