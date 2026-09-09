import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { useAdoptedAiSetupOpen } from '../../hooks/useAdoptedAiSetupPrompt'
import { useEmbeddingSyncDecision } from '../../hooks/useEmbeddingSyncDecision'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import type {
  EmbedSyncDecisionReason,
  EmbedSyncDecisionSlotView,
  EmbedSyncSlot,
} from '../../types/ai'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { RadioOptionPill } from '../common/RadioOptionPill'

function isKeyReason(reason: EmbedSyncDecisionReason | null): boolean {
  return reason === 'missing_key' || reason === 'invalid_key'
}

function slotLabelKey(slot: string): 'entry' | 'memory' {
  return slot === 'memory' ? 'memory' : 'entry'
}

/**
 * Blocking decision modal when multi-device embedding sync needs the user
 * to choose re-embed / switch peer model / pause — for entry and/or memory
 * slots. Mount once in the unlocked App shell; self-gates on store state.
 *
 * Dismiss (Esc / Close) = pause sync-backfill on pending slots (new local
 * edits keep indexing). Pause-state slots re-open via the footer chip.
 */
export function EmbeddingSyncDecisionModal() {
  const { t } = useTranslation('ai')
  const { decisionSlots, decisionModalOpen, resolve, dismissWithPause } = useEmbeddingSyncDecision()
  const adoptSetupOpen = useAdoptedAiSetupOpen((s) => s.open)
  const updateActiveTab = useUpdateActiveTab()

  const attentionSlots = useMemo(
    () => decisionSlots.filter((s) => s.needsModal || s.state === 'pending'),
    [decisionSlots],
  )

  // Per-slot selected peer model for Switch.
  const [selectedPeerBySlot, setSelectedPeerBySlot] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [errorBySlot, setErrorBySlot] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)

  if (adoptSetupOpen) return null
  if (!decisionModalOpen) return null
  if (attentionSlots.length === 0) return null

  const runAction = async (
    slot: EmbedSyncDecisionSlotView,
    action: 'reembed' | 'switch' | 'pause',
  ) => {
    const key = `${slot.slot}:${action}`
    setBusyKey(key)
    setErrorBySlot((prev) => {
      const next = { ...prev }
      delete next[slot.slot]
      return next
    })
    setGlobalError(null)
    try {
      const target = action === 'switch' ? selectedPeerBySlot[slot.slot] : undefined
      if (action === 'switch' && (!target || target.trim() === '')) {
        setErrorBySlot((prev) => ({
          ...prev,
          [slot.slot]: t('embedding_decision.error_select_peer'),
        }))
        return
      }
      const result = await resolve(slot.slot as EmbedSyncSlot, action, target)
      if (!result.ok) {
        setErrorBySlot((prev) => ({
          ...prev,
          [slot.slot]: result.error ?? t('embedding_decision.error_generic'),
        }))
        return
      }
      if (result.needsKey) {
        setErrorBySlot((prev) => ({
          ...prev,
          [slot.slot]: t('embedding_decision.needs_key_hint'),
        }))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErrorBySlot((prev) => ({
        ...prev,
        [slot.slot]: msg || t('embedding_decision.error_generic'),
      }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleDismiss = async () => {
    // Do not race pause with an in-flight reembed/switch.
    if (busyKey != null && busyKey !== 'dismiss') return
    setBusyKey('dismiss')
    setGlobalError(null)
    try {
      await dismissWithPause()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setGlobalError(msg || t('embedding_decision.error_generic'))
    } finally {
      setBusyKey(null)
    }
  }

  const openAiSettings = () => {
    updateActiveTab({ activeView: 'settings', selectedEntryId: null, settingsCategory: 'ai' })
  }

  const anyBusy = busyKey != null

  return (
    <Modal
      onClose={() => void handleDismiss()}
      maxWidth={560}
      disableEsc={anyBusy}
      disableBackdrop={anyBusy}
    >
      <Modal.Header description={t('embedding_decision.intro')}>
        <span className="flex items-center gap-2">
          <AlertTriangle className="text-warning size-5 shrink-0" strokeWidth={1.75} />
          <span className="font-title text-xl font-semibold">{t('embedding_decision.title')}</span>
        </span>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          {attentionSlots.map((slot) => {
            const sk = slotLabelKey(slot.slot)
            const peerSelected = selectedPeerBySlot[slot.slot] ?? ''
            const canSwitch = slot.reason === 'model_mismatch' && slot.peerModels.length > 0
            const showKeyCta = isKeyReason(slot.reason) || slot.reason === 'unconfigured'
            const err = errorBySlot[slot.slot]

            return (
              <section
                key={slot.slot}
                className="border-border-default bg-elevated space-y-3 rounded-lg border p-4"
                data-testid={`embed-decision-slot-${slot.slot}`}
              >
                <header>
                  <h3 className="text-fg text-sm font-semibold">
                    {t(`embedding_decision.slot_${sk}`)}
                  </h3>
                  <p className="text-fg-muted mt-1 text-sm leading-relaxed">
                    {t(`embedding_decision.reason_${slot.reason ?? 'model_mismatch'}`)}
                  </p>
                </header>

                <dl className="space-y-2 text-sm">
                  {slot.localModelId != null && slot.localModelId !== '' && (
                    <div>
                      <dt className="text-fg-muted font-medium">
                        {t('embedding_decision.local_model')}
                      </dt>
                      <dd className="text-fg mt-0.5 font-mono text-xs break-all">
                        {slot.localModelId}
                      </dd>
                    </div>
                  )}
                  {slot.pendingUnits > 0 && (
                    <div>
                      <dt className="text-fg-muted font-medium">
                        {t('embedding_decision.pending_units')}
                      </dt>
                      <dd className="text-fg mt-0.5">
                        {t('embedding_decision.pending_units_value', {
                          count: slot.pendingUnits,
                        })}
                      </dd>
                    </div>
                  )}
                </dl>

                {canSwitch && (
                  <div>
                    <p className="text-fg-muted mb-2 text-sm font-medium">
                      {t('embedding_decision.peer_models')}
                    </p>
                    <div
                      role="radiogroup"
                      aria-label={t('embedding_decision.peer_models')}
                      className="flex flex-wrap gap-2"
                    >
                      {slot.peerModels.map((p) => (
                        <RadioOptionPill
                          key={p.modelId}
                          selected={peerSelected === p.modelId}
                          disabled={anyBusy}
                          label={
                            <span className="flex items-center gap-1.5">
                              <span className="max-w-48 truncate font-mono text-xs">
                                {p.modelId}
                              </span>
                              <span className="text-fg-muted text-xs font-normal">({p.count})</span>
                            </span>
                          }
                          onClick={() =>
                            setSelectedPeerBySlot((prev) => ({
                              ...prev,
                              [slot.slot]: p.modelId,
                            }))
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {err != null && err !== '' && (
                  <p className="text-danger-text text-sm" role="alert">
                    {err}
                  </p>
                )}

                <div className="flex flex-wrap justify-end gap-2">
                  {showKeyCta && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={anyBusy}
                      onClick={openAiSettings}
                    >
                      {t('embedding_decision.open_ai_settings')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={anyBusy}
                    loading={busyKey === `${slot.slot}:pause`}
                    onClick={() => void runAction(slot, 'pause')}
                  >
                    {t('embedding_decision.action_pause')}
                  </Button>
                  {canSwitch && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={anyBusy || !peerSelected}
                      loading={busyKey === `${slot.slot}:switch`}
                      onClick={() => void runAction(slot, 'switch')}
                    >
                      {t('embedding_decision.action_switch')}
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={anyBusy}
                    loading={busyKey === `${slot.slot}:reembed`}
                    onClick={() => void runAction(slot, 'reembed')}
                  >
                    {t('embedding_decision.action_reembed')}
                  </Button>
                </div>
              </section>
            )
          })}

          <p className="text-fg-muted text-sm leading-relaxed">
            {t('embedding_decision.pause_keeps_local')}
          </p>

          {globalError != null && globalError !== '' && (
            <p className="text-danger-text text-sm" role="alert">
              {globalError}
            </p>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="ghost"
          size="sm"
          disabled={anyBusy}
          loading={busyKey === 'dismiss'}
          onClick={() => void handleDismiss()}
        >
          {t('embedding_decision.pause_all_close')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
