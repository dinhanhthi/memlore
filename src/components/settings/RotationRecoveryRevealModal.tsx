import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Download } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { cn } from '../../lib/cn'
import { useAuth } from '../../hooks/useAuth'
import { useRecoverySheet } from '../../hooks/useRecoverySheet'
import { toast } from '../../lib/toast'

interface Props {
  open: boolean
  phrase: string
  /**
   * True when this reveal follows a **reset** (Flow G): the phrase is NEW, the
   * old words are dead, and these 24 words are the only surviving copy. False
   * (default) for a plain rotate, where the phrase is unchanged. Drives the
   * title/body copy — showing "phrase unchanged" on a reset is a data-loss trap.
   */
  isReset?: boolean
  onConfirmed: () => void
}

export function RotationRecoveryRevealModal({ open, phrase, isReset = false, onConfirmed }: Props) {
  // Sheet-download strings live in the `auth` namespace (`recovery.sheet.*`);
  // load it alongside `settings` so this shared reveal modal can reuse them.
  const { t } = useTranslation(['settings', 'auth'])
  const { confirmRotationRecoverySaved } = useAuth()
  const { status: sheetStatus, saveSheet } = useRecoverySheet()

  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  // The download-confirm modal warns that the file stores the phrase in plain
  // text before any native save dialog can open (mirrors the onboarding reveal).
  const [showDownloadModal, setShowDownloadModal] = useState(false)

  const words = phrase.trim().split(/\s+/).filter(Boolean)

  // Confirm inside the download modal → render + save the PDF sheet. React to
  // the *returned* status (reading the hook's state right after the await is
  // stale). A saved/failed result surfaces as a bottom-right toast; dismissing
  // the save dialog resolves `cancelled` and stays silent.
  const handleDownloadConfirm = async () => {
    const result = await saveSheet(words)
    setShowDownloadModal(false)
    if (result.kind === 'saved') {
      toast(`${t('auth:recovery.sheet.saved_to')} ${result.path}`, {
        position: 'bottom-right',
        duration: 4000,
      })
    } else if (result.kind === 'error') {
      toast(t('auth:recovery.sheet.error', { message: result.message }), {
        position: 'bottom-right',
        duration: 4000,
      })
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(phrase)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable
    }
  }

  const handleDone = async () => {
    if (!saved || isBusy) return
    setError('')
    setIsBusy(true)
    const res = await confirmRotationRecoverySaved()
    if (res.success) {
      onConfirmed()
    } else {
      setError(res.error ?? t('security.rotate.error_fallback'))
      setIsBusy(false)
    }
  }

  if (!open) return null

  return (
    <Modal onClose={() => {}} disableEsc disableBackdrop maxWidth={560}>
      <Modal.Header
        description={
          isReset ? t('security.reset.new_phrase_body') : t('security.rotate.new_phrase_body')
        }
      >
        {isReset ? t('security.reset.new_phrase_title') : t('security.rotate.new_phrase_title')}
      </Modal.Header>
      <Modal.Body>
        <div className="flex flex-col gap-4">
          {/* 24-word grid — 4 columns × 6 rows (mirrors RecoveryPassphraseRevealScreen) */}
          <div
            className="grid grid-cols-4 gap-2"
            aria-label={t('auth:recovery.words_aria')}
            role="list"
          >
            {words.map((word, index) => (
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
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              size="md"
              icon={<Download className="size-4" aria-hidden="true" />}
              onClick={() => setShowDownloadModal(true)}
            >
              {t('auth:recovery.sheet.download')}
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
              onClick={() => void handleCopy()}
            >
              {copied ? t('security.rotate.copied') : t('security.rotate.copy')}
            </Button>
          </div>

          {/* "I saved it" checkbox */}
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="accent-accent mt-0.5 size-4 shrink-0 cursor-pointer rounded"
            />
            <span className="text-fg text-sm leading-relaxed">
              {t('security.rotate.i_saved_checkbox')}
            </span>
          </label>

          {/* Error */}
          {error && (
            <p role="alert" className="text-danger-text text-xs">
              {error}
            </p>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="primary"
          size="sm"
          loading={isBusy}
          disabled={!saved || isBusy}
          onClick={() => void handleDone()}
        >
          {t('security.rotate.done')}
        </Button>
      </Modal.Footer>

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
          <Modal.Header>{t('auth:recovery.sheet.download_modal_title')}</Modal.Header>
          <Modal.Body>
            <Callout tone="warning">
              <p className="leading-relaxed">{t('auth:recovery.sheet.warning')}</p>
              <p className="mt-2 leading-relaxed">{t('auth:recovery.sheet.not_a_backup')}</p>
            </Callout>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="sm"
              disabled={sheetStatus.kind === 'saving'}
              onClick={() => setShowDownloadModal(false)}
            >
              {t('auth:recovery.sheet.download_modal_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={sheetStatus.kind === 'saving'}
              icon={<Download className="size-4" aria-hidden="true" />}
              onClick={() => void handleDownloadConfirm()}
            >
              {sheetStatus.kind === 'saving'
                ? t('auth:recovery.sheet.preparing')
                : t('auth:recovery.sheet.download_modal_confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </Modal>
  )
}
