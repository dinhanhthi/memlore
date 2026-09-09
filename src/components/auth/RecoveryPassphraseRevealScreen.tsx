import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Download } from 'lucide-react'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { AuthPageCard } from '../common/AuthPageCard'
import { useRecoverySheet } from '../../hooks/useRecoverySheet'
import { toast } from '../../lib/toast'
import { cn } from '../../lib/cn'

interface Props {
  mnemonic: string[]
  isResumed?: boolean
  onContinue: () => void
  onCancel: () => void
}

export function RecoveryPassphraseRevealScreen({
  mnemonic,
  isResumed,
  onContinue,
  onCancel,
}: Props) {
  const { t } = useTranslation('auth')
  const { status: sheetStatus, saveSheet } = useRecoverySheet()
  const [copied, setCopied] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  // The download-confirm modal is independent of the "last chance" modal above:
  // it warns that the file stores the phrase in plain text before any save
  // dialog can open, and it carries no acknowledgement checkbox.
  const [showDownloadModal, setShowDownloadModal] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic.join(' '))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (non-HTTPS in dev, sandboxed context, etc.)
    }
  }

  // Confirm inside the download modal → render + save the PDF sheet. React to
  // the *returned* status (reading the hook's state right after the await is
  // stale). A saved/failed result surfaces as a bottom-right toast; dismissing
  // the save dialog resolves `cancelled` and stays silent.
  const handleDownloadConfirm = async () => {
    const result = await saveSheet(mnemonic)
    setShowDownloadModal(false)
    if (result.kind === 'saved') {
      toast(`${t('recovery.sheet.saved_to')} ${result.path}`, {
        position: 'bottom-right',
        duration: 4000,
      })
    } else if (result.kind === 'error') {
      toast(t('recovery.sheet.error', { message: result.message }), {
        position: 'bottom-right',
        duration: 4000,
      })
    }
  }

  const handleContinueClick = () => {
    setAcknowledged(false)
    setShowConfirmModal(true)
  }

  const handleModalConfirm = () => {
    setShowConfirmModal(false)
    onContinue()
  }

  const handleModalCancel = () => {
    setShowConfirmModal(false)
  }

  return (
    <AuthPageCard data-testid="recovery-reveal-screen" className="max-w-160 p-8">
      {/* Resume notice */}
      {isResumed && (
        <Callout tone="warning" className="mb-6">
          {t('recovery.resume_notice')}
        </Callout>
      )}

      {/* Header */}
      <div className="mb-6 flex flex-col gap-2">
        <h1 className="font-title text-fg text-2xl font-extrabold">{t('recovery.intro_title')}</h1>
        <p className="text-fg-muted text-sm leading-relaxed">{t('recovery.intro_body')}</p>
      </div>

      {/* Warning callout */}
      <Callout tone="warning" className="mb-6">
        {t('recovery.write_down_warning')}
      </Callout>

      {/* 24-word grid — 4 columns × 6 rows */}
      <div
        className="mb-6 grid grid-cols-4 gap-2"
        aria-label={t('recovery.words_aria')}
        role="list"
      >
        {mnemonic.map((word, index) => (
          <div
            key={index}
            role="listitem"
            className={cn(
              'border-border-default bg-elevated flex items-center gap-1.5',
              'rounded-xl border px-2.5 py-1.5',
            )}
          >
            <span className="text-fg-muted text-2xs w-5 shrink-0 text-right font-medium tabular-nums">
              {index + 1}
            </span>
            <span className="text-fg font-mono text-sm font-medium">{word}</span>
          </div>
        ))}
      </div>

      {/* Download + Copy row */}
      <div className="mb-6 flex flex-wrap gap-3">
        <Button
          variant="secondary"
          size="md"
          icon={<Download className="size-4" aria-hidden="true" />}
          onClick={() => setShowDownloadModal(true)}
        >
          {t('recovery.sheet.download')}
        </Button>
        <Button
          variant="secondary"
          size="md"
          icon={
            copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )
          }
          onClick={handleCopy}
        >
          {copied ? t('recovery.copied') : t('recovery.copy_to_clipboard')}
        </Button>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="md" onClick={onCancel}>
          {t('recovery.cancel_setup')}
        </Button>
        <Button variant="primary" size="md" onClick={handleContinueClick}>
          {t('recovery.continue_to_confirm')}
        </Button>
      </div>

      {/* "Last chance" confirmation modal */}
      {showConfirmModal && (
        <Modal onClose={handleModalCancel} maxWidth={460}>
          <Modal.Header description={t('recovery.lose_warning_modal_body')}>
            {t('recovery.lose_warning_modal_title')}
          </Modal.Header>
          <Modal.Body>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="accent-accent mt-0.5 size-4 shrink-0 cursor-pointer rounded"
              />
              <span className="text-fg text-sm leading-relaxed">
                {t('recovery.lose_warning_modal_ack')}
              </span>
            </label>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" size="sm" onClick={handleModalCancel}>
              {t('recovery.lose_warning_modal_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!acknowledged}
              onClick={handleModalConfirm}
            >
              {t('recovery.lose_warning_modal_confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Download-sheet confirmation modal. The plaintext-file warning renders
          here, before the native save dialog can ever open. */}
      {showDownloadModal && (
        <Modal
          onClose={
            // Block backdrop/Escape close while a save is in flight, so the
            // modal can't vanish out from under an open save dialog.
            sheetStatus.kind === 'saving' ? () => {} : () => setShowDownloadModal(false)
          }
          maxWidth={460}
        >
          <Modal.Header>{t('recovery.sheet.download_modal_title')}</Modal.Header>
          <Modal.Body>
            <Callout tone="warning">
              <p className="leading-relaxed">{t('recovery.sheet.warning')}</p>
              <p className="mt-2 leading-relaxed">{t('recovery.sheet.not_a_backup')}</p>
            </Callout>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="sm"
              disabled={sheetStatus.kind === 'saving'}
              onClick={() => setShowDownloadModal(false)}
            >
              {t('recovery.sheet.download_modal_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={sheetStatus.kind === 'saving'}
              icon={<Download className="size-4" aria-hidden="true" />}
              onClick={() => void handleDownloadConfirm()}
            >
              {sheetStatus.kind === 'saving'
                ? t('recovery.sheet.preparing')
                : t('recovery.sheet.download_modal_confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </AuthPageCard>
  )
}
