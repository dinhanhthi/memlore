import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { PasswordInput } from '../common/PasswordInput'
import { TextInput } from '../common/TextInput'
import { BIP39_EN } from '../../lib/bip39-wordlist-en'
import { errMsg } from '../../lib/errMsg'
import { resumeRotation } from '../../lib/tauri'

const SYNC_IN_PROGRESS_ERR = 'sync_in_progress'

interface Props {
  open: boolean
  /**
   * True when the interrupted job is a REVOKE rotation (requires 24-word
   * recovery phrase). False for plain ROTATE jobs (password only).
   */
  isRevoke: boolean
  onCompleted: () => void
}

/**
 * Modal shown on startup when a crash-interrupted rotation is detected.
 *
 * - ROTATE job: user supplies only their current device password.
 * - REVOKE job: user must also supply the 24-word recovery phrase.
 *
 * This corresponds to the `xj://rotation-resume-required` backend event,
 * handled by `useRotationResume`.
 */
export function RotationResumeModal({ open, isRevoke, onCompleted }: Props) {
  const { t } = useTranslation('settings')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')

  const words = useMemo(() => phrase.trim().split(/\s+/).filter(Boolean), [phrase])
  const wordCount = words.length
  const unknownWords = useMemo(() => words.filter((w) => !BIP39_EN.has(w.toLowerCase())), [words])
  const passphraseReady = wordCount === 24 && unknownWords.length === 0

  // ROTATE: only password required. REVOKE: password + valid 24-word phrase.
  const canResume = isRevoke
    ? password.length > 0 && passphraseReady && !isBusy
    : password.length > 0 && !isBusy

  const handleResume = async () => {
    if (!canResume) return
    setError('')
    setIsBusy(true)
    try {
      // For ROTATE jobs the backend resumes from the stash — no phrase needed.
      // For REVOKE jobs the mnemonic is required to reconstruct the device key.
      await resumeRotation(password, isRevoke ? phrase.trim().toLowerCase() : undefined)
      onCompleted()
    } catch (err) {
      // Tauri v2 rejects `Result<_, String>` commands with a plain string, not
      // an Error — so `err instanceof Error` is false for every backend failure.
      // Map the machine token; otherwise surface the backend message.
      const raw = errMsg(err)
      const msg =
        raw === SYNC_IN_PROGRESS_ERR
          ? t('security.secure_wizard.errors.sync_in_progress')
          : raw || t('security.rotation_resume.error_fallback')
      setError(msg)
      setIsBusy(false)
    }
  }

  if (!open) return null

  return (
    <Modal disableEsc={isBusy} disableBackdrop={isBusy} onClose={() => {}}>
      <Modal.Header>
        <span className="font-title text-xl font-semibold">
          {t('security.rotation_resume.modal_title')}
        </span>
      </Modal.Header>
      <Modal.Body>
        <div className="flex flex-col gap-4">
          {/* Warning banner — copy differs by job kind */}
          <Callout tone="warning">
            {isRevoke
              ? t('security.rotation_resume.warning')
              : t('security.rotation_resume.warning_rotate')}
          </Callout>

          {/* Busy state is surfaced by the footer button's loading spinner. */}
          {!isBusy && (
            <>
              {/* Current password */}
              <div className="flex flex-col gap-1">
                <label className="text-fg-muted text-xs font-medium">
                  {t('security.rotation_resume.password_label')}
                </label>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  placeholder={t('security.rotation_resume.password_placeholder')}
                  disabled={isBusy}
                />
              </div>

              {/* Recovery phrase — only required for REVOKE jobs */}
              {isRevoke && (
                <div className="flex flex-col gap-1">
                  <label className="text-fg-muted text-xs font-medium">
                    {t('security.rotation_resume.passphrase_label')}
                  </label>
                  <TextInput
                    multiline
                    value={phrase}
                    onChange={(next) => {
                      setPhrase(next)
                      setError('')
                    }}
                    placeholder={t('security.rotation_resume.passphrase_placeholder')}
                    rows={3}
                    disabled={isBusy}
                    spellCheck={false}
                    className="resize-none"
                  />
                  <p className={passphraseReady ? 'text-success text-xs' : 'text-fg-muted text-xs'}>
                    {t('security.rotation_resume.passphrase_word_count', { count: wordCount })}
                  </p>
                  {unknownWords.length > 0 && (
                    <p className="text-warning text-xs">
                      {t('security.rotation_resume.passphrase_unknown_words', {
                        words: unknownWords.join(', '),
                      })}
                    </p>
                  )}
                </div>
              )}
            </>
          )}

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
          onClick={() => void handleResume()}
          disabled={!canResume}
        >
          {isBusy ? t('security.rotation_resume.resuming') : t('security.rotation_resume.resume')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
