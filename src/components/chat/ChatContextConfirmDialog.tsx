import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import type { ChatContextRefusal } from '../../types/ai'

type NeedsConfirmationRefusal = Extract<ChatContextRefusal, { code: 'needs_confirmation' }>

export interface ChatContextConfirmDialogProps {
  /** The backend's `needs_confirmation` refusal for *this* send attempt.
   *  These numbers — not the debounced preflight's — are what the user is
   *  actually consenting to, because the backend recomputed the plan at
   *  send time. */
  refusal: NeedsConfirmationRefusal
  /** Resend the identical turn with `oversizeConfirmed: true`. Confirming
   *  does not raise any cap — the hard caps still trim. */
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Shown when `daily_chat_send_turn` refuses a send with `needs_confirmation`.
 * Must name the concrete numbers being consented to — a generic "are you
 * sure?" trains the user to dismiss it, defeating the point of the gate.
 * No "don't ask again" option: the user explicitly asked to decide every time.
 */
export function ChatContextConfirmDialog({
  refusal,
  onConfirm,
  onCancel,
}: ChatContextConfirmDialogProps) {
  const { t } = useTranslation('ai')
  const totalKb = Math.round(refusal.totalBytes / 1024)
  const estimatedKb = Math.round(refusal.estimatedBytes / 1024)

  // `count` (not a plain `entriesTotal` interpolation) so i18next can select
  // `_one` / `_other` resource keys once Phase 6 adds them — "has 1 entries"
  // is a real sentence for a single-entry period/attachment set.
  // `entriesIncluded` never precedes a noun ("about {{n}} of them"), so it
  // needs no plural form of its own.
  const body =
    refusal.label !== null
      ? t('daily_chat.context_confirm_body', {
          count: refusal.entriesTotal,
          label: refusal.label,
          totalKb,
          entriesIncluded: refusal.entriesIncluded,
          estimatedKb,
          defaultValue:
            '"{{label}}" has {{count}} entries (≈ {{totalKb}} KB). Only excerpts from about {{entriesIncluded}} of them will be sent (≈ {{estimatedKb}} KB). Continue?',
        })
      : t('daily_chat.context_confirm_body_no_period', {
          count: refusal.entriesTotal,
          totalKb,
          entriesIncluded: refusal.entriesIncluded,
          estimatedKb,
          defaultValue:
            'These attachments total {{count}} entries (≈ {{totalKb}} KB). Only excerpts from about {{entriesIncluded}} of them will be sent (≈ {{estimatedKb}} KB). Continue?',
        })

  return (
    <Modal onClose={onCancel} maxWidth={440}>
      <Modal.Header description={body}>
        {t('daily_chat.context_confirm_title', { defaultValue: 'Send this much context?' })}
      </Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('daily_chat.context_confirm_cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm}>
          {t('daily_chat.context_confirm_send', { defaultValue: 'Send anyway' })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
