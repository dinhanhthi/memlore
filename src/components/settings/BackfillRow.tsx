import { AlertTriangle, CheckCircle2, CircleHelp, Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { needsHostedConsent, useBackfillStatus } from '../../hooks/useBackfillStatus'
import { useEmbedIncludeProtected } from '../../hooks/useEmbedIncludeProtected'
import { useEmbeddingStatus } from '../../hooks/useEmbeddingStatus'
import { cn } from '../../lib/cn'
import { errMsg } from '../../lib/errMsg'
import {
  getEmbeddingStatusLabel,
  getEmbeddingStatusToneClass,
} from '../../lib/embeddingStatusLabel'
import { UsageWarning } from '../ai/UsageWarning'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { InlineOrb } from '../common/ThinkingOrb'
import { ShimmerText } from '../common/ShimmerText'
import { Tooltip } from '../common/Tooltip'
import { SettingsRow } from './SettingsRow'
import { Toggle } from './Toggle'

/// Background indexing + embedding-index status/controls (Phase 3 Task 3).
///
/// Renders inline inside `AISettingsPanel` whenever the user has configured
/// an embedding provider. Three parts, top to bottom:
///   1. Master toggle for the automatic (debounced) background worker —
///      gated behind a token-cost consent step when the provider is hosted.
///   2. Live embedding-index status (mirrors `useEmbeddingStatus`) with
///      status label + indexed count on one row, and a section footer of
///      manual controls: Pause / Resume / Index now / Rebuild index
///      (secondary buttons, side by side).
///   3. Opt-in toggle to include locked/invisible entries in the index,
///      with a risk/benefit notice shown before enabling.
interface BackfillRowProps {
  /** When true, surfaces a prompt to re-embed after an embedding-model swap. */
  showReindexPrompt?: boolean
  onDismissReindexPrompt?: () => void
  /** Drop the outer card so these sections can be appended INSIDE another
   *  card — the Models tab renders them under the Embedding model row so all
   *  four embedding controls share one surface. The sections keep their own
   *  `border-t` dividers, so the host must supply the card chrome. */
  bare?: boolean
}

export function BackfillRow({
  showReindexPrompt,
  onDismissReindexPrompt,
  bare = false,
}: BackfillRowProps) {
  const { t } = useTranslation('ai')
  const {
    status: runStatus,
    indexStats,
    lastCompletion,
    error,
    start,
    pause,
    backgroundEnabled,
    hostedConsentAt,
    setBackgroundEnabled,
    acceptHostedConsent,
  } = useBackfillStatus()
  const {
    status,
    pendingCount,
    providerKind,
    downloadProgress,
    refresh: refreshEmbeddingStatus,
  } = useEmbeddingStatus()
  const { includeProtected, setIncludeProtected } = useEmbedIncludeProtected()

  const running = runStatus.running
  const total = runStatus.total
  const indexed = runStatus.indexed
  // A run that broke on an embed error still emits `ai:backfill-complete`
  // with `cancelled: false`, so gate the success message on the absence of a
  // *displayed* error — otherwise a failed run falsely reads "All entries
  // indexed". This must mirror the error-`<p>` render condition below exactly
  // so we always show precisely one of done / cancelled / error, never none.
  const hasVisibleError = !!error && !error.includes('AI_BACKFILL_STATUS_FAILED')
  const paused = status === 'paused'
  const statusInFlight = status === 'indexing' || status === 'downloading_model'
  const statusLabel = getEmbeddingStatusLabel(status, pendingCount, t, downloadProgress)

  // Which button, if any, is mid-flight — drives its spinner so a click on
  // "Index now" gives instant feedback even when there is nothing to
  // index (the command returns almost immediately in that case).
  const [pending, setPending] = useState<null | 'start' | 'force'>(null)
  /// Resolves to whether the run actually started, so a caller can hold
  /// back its own state change (the re-index prompt dismissal) until the
  /// command succeeded. Failures are swallowed here on purpose: `start`
  /// already publishes them through `error`, and every call site is a
  /// `void`-ed click handler where a rethrow only becomes an unhandled
  /// rejection.
  const runStart = async (force: boolean): Promise<boolean> => {
    setPending(force ? 'force' : 'start')
    try {
      await start(force)
      // Resume with an already-drained queue emits no progress/completion
      // event, so only this refresh (which reads `get_backfill_status`)
      // clears the "Paused" label here and in the footer.
      await refreshEmbeddingStatus()
      return true
    } catch {
      return false
    } finally {
      setPending(null)
    }
  }

  // Transient green "all indexed" confirmation inline with the indexed count.
  // Click feedback, not a persistent state — appears only after a successful
  // run and auto-dismisses after a few seconds. `lastCompletion` is a fresh
  // object per completion event, so this effect re-fires on every finished run.
  const [flashDone, setFlashDone] = useState(false)
  useEffect(() => {
    if (!lastCompletion || lastCompletion.cancelled || hasVisibleError) return
    setFlashDone(true)
    const id = setTimeout(() => setFlashDone(false), 4000)
    return () => clearTimeout(id)
  }, [lastCompletion, hasVisibleError])

  // ── Background indexing master toggle + hosted consent ──────────────────
  const isHosted = providerKind === 'hosted'
  const [showConsentModal, setShowConsentModal] = useState(false)
  const [consentPending, setConsentPending] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [backgroundToggleError, setBackgroundToggleError] = useState<string | null>(null)

  const openConsentModal = () => {
    setConsentError(null)
    setShowConsentModal(true)
  }
  const closeConsentModal = () => {
    setConsentError(null)
    setShowConsentModal(false)
  }

  const handleToggleBackground = async (next: boolean) => {
    if (next && needsHostedConsent(providerKind, hostedConsentAt)) {
      openConsentModal()
      return
    }
    setBackgroundToggleError(null)
    try {
      await setBackgroundEnabled(next)
      await refreshEmbeddingStatus()
    } catch (e) {
      setBackgroundToggleError(errMsg(e))
    }
  }

  const handleAcceptConsent = async () => {
    setConsentPending(true)
    setConsentError(null)
    try {
      await acceptHostedConsent()
      await setBackgroundEnabled(true)
      await refreshEmbeddingStatus()
      setShowConsentModal(false)
    } catch (e) {
      // Keep the modal open on failure so the user can see the message and
      // retry — closing it here would silently strand them (cf-review C3).
      setConsentError(errMsg(e))
    } finally {
      setConsentPending(false)
    }
  }

  // ── Rebuild index confirm ─────────────────────────────────────────────────
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false)

  // ── Protected-entry toggle + risk/benefit notice ─────────────────────────
  const [showProtectedRisk, setShowProtectedRisk] = useState(false)

  const handleToggleProtected = (next: boolean) => {
    if (next) {
      setShowProtectedRisk(true)
      return
    }
    void setIncludeProtected(false)
  }

  return (
    <div
      className={cn(
        bare
          ? // Sits inside the host card: cancel its padding so the section
            // dividers span the full width, and lead with a divider of our own
            // since the model row above is now the first section.
            'border-border-default -mx-4 -mb-4 border-t'
          : 'border-border-card bg-surface-hi overflow-hidden rounded-2xl border',
      )}
    >
      {/* Background indexing master toggle */}
      <div className="px-4">
        <SettingsRow
          title={t('background.title')}
          hint={t('background.description')}
          divider={false}
          className="py-3"
        >
          <Toggle
            checked={backgroundEnabled}
            onChange={(v) => void handleToggleBackground(v)}
            ariaLabel={t('background.title')}
          />
        </SettingsRow>
        {backgroundToggleError && (
          <p className="text-danger-text -mt-1 pb-2 text-xs">
            {t([`error.${backgroundToggleError}`, 'error.AI_BACKFILL_FAILED'])}
          </p>
        )}
        {!isHosted && (
          <p className="text-success-text -mt-1 pb-3 text-xs">{t('background.local_note')}</p>
        )}
      </div>

      {/* Embedding-index status + section actions */}
      <div className="border-border-default border-t px-4 py-3.5">
        <h3 className="text-fg text-sm font-semibold">{t('backfill.title')}</h3>
        <p className="text-fg-muted mt-0.5 text-xs leading-snug">{t('backfill.description')}</p>

        {/* Status label + indexed count share one row */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <div
            className={cn(
              'flex items-center gap-1.5 font-medium',
              getEmbeddingStatusToneClass(status),
            )}
          >
            {(status === 'error' || status === 'stuck') && (
              <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
            )}
            {statusInFlight && <InlineOrb state="searching" aria-hidden />}
            <ShimmerText active={statusInFlight}>{statusLabel}</ShimmerText>
            {status === 'waiting' && (
              <Tooltip content={t('backfill.status_waiting_help')} multiline placement="top">
                <button
                  type="button"
                  aria-label={t('backfill.status_waiting_help')}
                  className="text-fg-muted hover:text-fg-secondary inline-flex shrink-0 cursor-help items-center rounded-full outline-none"
                >
                  <CircleHelp className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
          </div>
          {/* Shown while running too: the continuous worker holds the run
              slot for the whole session, so gating this on `!running` hid
              the count during normal operation and right after Resume. The
              numbers refresh on `ai:backfill-complete`; the progress bar
              below is the live element during a run. */}
          {indexStats.total > 0 && (
            <>
              <span className="text-fg-muted" aria-hidden>
                ·
              </span>
              <span className="text-fg-secondary">
                {t('backfill.indexed_count', {
                  indexed: indexStats.indexed,
                  total: indexStats.total,
                })}
              </span>
              {flashDone && (
                <span className="text-success inline-flex items-center gap-1">
                  <CheckCircle2 className="text-success size-3.5 shrink-0" />
                  {t('backfill.complete')}
                </span>
              )}
            </>
          )}
        </div>

        {/* Third `!running` gate of the same family: saving an embedding
            slot does `cancel_and_clear` + a synchronous
            `start_indexing_worker`, so the slot is re-occupied before this
            prompt can ever render — the model-swap re-index offer was dead
            on arrival. Dismissal is the explicit button, not the run state. */}
        {showReindexPrompt && (
          <div className="border-accent/30 bg-accent-soft mt-2.5 rounded-xl border p-3">
            <p className="text-fg text-sm leading-snug">{t('backfill.reindex_needed')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* Routes through the SAME confirm as "Rebuild index" below:
                  both call `runStart(true)` → one `force_reindex_wipe_and_
                  requeue` that re-embeds the whole corpus, and
                  `start_backfill` gates only on the one-time privacy
                  receipt — never on `hostedConsentAt` — so nothing
                  server-side re-checks the cost of this click. */}
              <Button variant="primary" size="sm" onClick={() => setShowRebuildConfirm(true)}>
                {t('backfill.reindex_start')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onDismissReindexPrompt?.()}>
                {t('backfill.reindex_dismiss')}
              </Button>
            </div>
          </div>
        )}

        {/* Gated on live indexing, not on `running`: the continuous worker
            holds the run slot all session, so `running` left an empty bar
            sitting under "Up to date" forever. `runStatus` counts THIS
            run's embeds (not the whole index like the chip above), which
            only reads as progress while a run is actually moving. */}
        {status === 'indexing' && (
          <div className="bg-fg-muted/20 mt-2.5 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-accent h-full transition-[width] duration-300"
              style={{
                width: total > 0 ? `${Math.min(100, (indexed / total) * 100)}%` : '0%',
              }}
              aria-hidden="true"
            />
          </div>
        )}

        {hasVisibleError && (
          <p className="text-danger-text mt-2.5 text-xs">
            {t([`error.${error}`, 'error.AI_BACKFILL_FAILED'])}
          </p>
        )}

        {status === 'needs_consent' && (
          <div className="mt-2.5">
            <Button variant="secondary" size="sm" onClick={openConsentModal}>
              {t('backfill.review_consent')}
            </Button>
          </div>
        )}

        {/* Same section as status above — no divider. Only Pause is
            run-state specific: the continuous worker holds the run slot for
            the whole session, so gating Index now / Rebuild on `!running`
            made them reachable only by pausing first. Both commands already
            tolerate a live worker — non-force takes the requeue (unstick)
            pass, `force` hits `start_backfill`'s `None if force` arm and
            wipes + requeues in place. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {running && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Pause className="size-3.5" strokeWidth={2} />}
              onClick={() => {
                void pause()
              }}
            >
              {t('backfill.pause')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            loading={pending === 'start'}
            icon={<Play className="size-3.5" strokeWidth={2} />}
            onClick={() => {
              void runStart(false)
            }}
          >
            {paused ? t('backfill.resume') : t('backfill.index_now')}
          </Button>
          {/* Rebuild: wipes existing rows for the current model first —
              keep an explicit confirm since it re-embeds everything. */}
          <Button
            variant="secondary"
            size="sm"
            icon={<RotateCcw className="size-3.5" strokeWidth={2} />}
            onClick={() => setShowRebuildConfirm(true)}
          >
            {t('backfill.rebuild')}
          </Button>
          {/* Rebuild always re-embeds every entry from scratch — only a
              token-cost concern with a hosted provider (local/on-device
              indexing has no token cost, so no warning there). */}
          {isHosted && <UsageWarning tooltip={t('usage_warning.rebuild_index')} />}
        </div>
      </div>

      {/* Protected-entry toggle */}
      <div className="border-border-default border-t px-4 py-1">
        <SettingsRow
          title={t('background.protected_title')}
          hint={t('background.protected_description')}
          divider={false}
          className="py-3"
        >
          <Toggle
            checked={includeProtected}
            onChange={handleToggleProtected}
            ariaLabel={t('background.protected_title')}
          />
        </SettingsRow>
        {showProtectedRisk && (
          <div className="border-border-default bg-app/40 mb-3 space-y-2 rounded-xl border p-3">
            <p className="text-xs leading-snug">
              <strong className="text-fg">{t('background.protected_risk_title')}: </strong>
              <span className="text-fg-secondary">{t('background.protected_risk_body')}</span>
            </p>
            <p className="text-xs leading-snug">
              <strong className="text-fg">{t('background.protected_benefit_title')}: </strong>
              <span className="text-fg-secondary">{t('background.protected_benefit_body')}</span>
            </p>
            <p className="text-fg-muted text-2xs">{t('background.protected_read_note')}</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setShowProtectedRisk(false)}>
                {t('action.forget_cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void setIncludeProtected(true)
                  setShowProtectedRisk(false)
                }}
              >
                {t('background.protected_confirm_enable')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Hosted token-cost consent modal */}
      {showConsentModal && (
        <Modal onClose={closeConsentModal} maxWidth={460}>
          <Modal.Header description={t('background.consent_body')}>
            {t('background.consent_title')}
          </Modal.Header>
          {consentError && (
            <Modal.Body>
              <p className="text-danger-text text-sm">
                {t([`error.${consentError}`, 'error.AI_BACKFILL_FAILED'])}
              </p>
            </Modal.Body>
          )}
          <Modal.Footer>
            <Button variant="ghost" size="sm" onClick={closeConsentModal}>
              {t('background.consent_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={consentPending}
              onClick={() => void handleAcceptConsent()}
            >
              {t('background.consent_accept')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Rebuild-index confirm modal */}
      {showRebuildConfirm && (
        <Modal onClose={() => setShowRebuildConfirm(false)} maxWidth={460}>
          <Modal.Header description={t('backfill.rebuild_confirm_body')}>
            {t('backfill.rebuild_confirm_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="ghost" size="sm" onClick={() => setShowRebuildConfirm(false)}>
              {t('action.forget_cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              loading={pending === 'force'}
              onClick={() => {
                setShowRebuildConfirm(false)
                void runStart(true).then((ok) => {
                  // A completed rebuild re-embeds everything with the
                  // current model, which is exactly what the model-swap
                  // prompt asks for — retire it. Only on success: the
                  // prompt is `useState` in AISettingsPanel with no trigger
                  // other than another model swap, so dismissing it after a
                  // failed run would strand the user with no way back.
                  if (ok) onDismissReindexPrompt?.()
                })
              }}
            >
              {t('backfill.rebuild_confirm_yes')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}
