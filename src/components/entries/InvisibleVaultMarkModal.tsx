import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeOff } from 'lucide-react'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { PasswordInput } from '../common/PasswordInput'
import { MIN_SECOND_LOCK_PASSWORD_LEN } from '../../lib/passwordStrength'

interface InvisibleVaultMarkModalProps {
  open: boolean
  onClose: () => void
  /** Called with the password after local validation (match + min length). */
  onSubmit: (password: string) => Promise<void>
}

/**
 * Password + confirm modal for quick-hide: mark an entry invisible without
 * unlocking the vault session. Confirm guards against typos creating a
 * stray vault with no recovery.
 */
export function InvisibleVaultMarkModal({ open, onClose, onSubmit }: InvisibleVaultMarkModalProps) {
  const { t } = useTranslation('editor')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setPassword('')
      setConfirm('')
      setError(null)
      setIsBusy(false)
    }
  }, [open])

  if (!open) return null

  const handleClose = () => {
    if (isBusy) return
    setPassword('')
    setConfirm('')
    setError(null)
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isBusy) return

    if ([...password].length < MIN_SECOND_LOCK_PASSWORD_LEN) {
      setError(
        t('entry_context.invisible_mark_too_short', {
          count: MIN_SECOND_LOCK_PASSWORD_LEN,
          defaultValue: `Use at least ${MIN_SECOND_LOCK_PASSWORD_LEN} characters.`,
        }),
      )
      return
    }
    if (password !== confirm) {
      setError(
        t('entry_context.invisible_mark_mismatch', {
          defaultValue: 'Passwords do not match.',
        }),
      )
      return
    }

    setIsBusy(true)
    setError(null)
    try {
      await onSubmit(password)
      setPassword('')
      setConfirm('')
      onClose()
    } catch {
      setError(
        t('entry_context.invisible_mark_error', {
          defaultValue: 'Unable to update.',
        }),
      )
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <Modal onClose={handleClose} maxWidth={420} disableEsc={isBusy} disableBackdrop={isBusy}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Modal.Header>
          <div className="flex items-start gap-4">
            <div
              aria-hidden="true"
              className="text-accent bg-accent-soft grid h-11 w-11 shrink-0 place-items-center rounded-xl"
            >
              <EyeOff className="size-6" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-title text-xl font-semibold">
                {t('entry_context.invisible_mark_title', {
                  defaultValue: 'Invisible lock',
                })}
              </div>
              <p className="text-fg-muted mt-1.5 text-sm leading-[1.55]">
                {t('entry_context.invisible_mark_description', {
                  defaultValue:
                    'Enter a password to hide this entry. The rest of that vault stays hidden until you open it separately.',
                })}
              </p>
            </div>
          </div>
        </Modal.Header>
        <Modal.Body fitContent className="space-y-2 pt-2">
          <PasswordInput
            value={password}
            onChange={(value) => {
              setPassword(value)
              if (error) setError(null)
            }}
            placeholder={t('entry_context.invisible_mark_password_placeholder', {
              defaultValue: 'Password',
            })}
            autoComplete="new-password"
            autoFocus
            disabled={isBusy}
          />
          <PasswordInput
            value={confirm}
            onChange={(value) => {
              setConfirm(value)
              if (error) setError(null)
            }}
            placeholder={t('entry_context.invisible_mark_confirm_placeholder', {
              defaultValue: 'Confirm password',
            })}
            autoComplete="new-password"
            disabled={isBusy}
          />
          {error && <p className="text-danger-text text-sm leading-[1.45]">{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={isBusy}>
            {t('entry_context.invisible_mark_cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={isBusy}
            disabled={password.length === 0 || confirm.length === 0}
          >
            {t('entry_context.invisible_mark_submit', { defaultValue: 'Hide entry' })}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

export type { InvisibleVaultMarkModalProps }
