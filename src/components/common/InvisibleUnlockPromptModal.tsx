import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeOff } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import { useInvisibleLock } from '../../hooks/useInvisibleLock'
import { MIN_SECOND_LOCK_PASSWORD_LEN } from '../../lib/passwordStrength'

interface InvisibleUnlockPromptModalProps {
  open: boolean
  onClose: () => void
  title: string
  description: string
  onUnlocked?: () => void | Promise<void>
}

export function InvisibleUnlockPromptModal({
  open,
  onClose,
  title,
  description,
  onUnlocked,
}: InvisibleUnlockPromptModalProps) {
  const { t } = useTranslation('palette')
  const { openOrCreate } = useInvisibleLock(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setPassword('')
      setError(null)
      setIsBusy(false)
    }
  }, [open])

  if (!open) return null

  const handleClose = () => {
    if (isBusy) return
    setPassword('')
    setError(null)
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isBusy) return

    // Pass password as-is (no trim) — backend matches the exact bytes the user
    // set when creating/opening a vault. Trimming would create a different vault
    // if the real password has leading/trailing spaces.
    if (password.length === 0 || [...password].length < MIN_SECOND_LOCK_PASSWORD_LEN) {
      setError(t('action.unlock_invisible_error'))
      return
    }

    setIsBusy(true)
    setError(null)
    try {
      // Open matching vault or create a new empty one — always unlocks on success.
      await openOrCreate(password)
      await onUnlocked?.()
      setPassword('')
      onClose()
    } catch {
      setError(t('action.unlock_invisible_error'))
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
              className="text-accent bg-accent-soft grid h-11 w-11 shrink-0 place-items-center rounded-[12px]"
            >
              <EyeOff className="size-6" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-title text-xl font-semibold">{title}</div>
              <p className="text-fg-muted mt-1.5 text-sm leading-[1.55]">{description}</p>
            </div>
          </div>
        </Modal.Header>
        <Modal.Body fitContent className="pt-2">
          <label className="block">
            <span className="text-fg-muted text-xs font-semibold tracking-[0.02em] uppercase">
              {t('action.unlock_invisible_password')}
            </span>
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                if (error) setError(null)
              }}
              disabled={isBusy}
              className="border-border-default bg-surface-hi text-fg placeholder:text-fg-muted focus:border-accent focus:ring-focus-ring mt-2 h-10 w-full rounded-[12px] border px-3 text-sm outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
              placeholder={t('action.unlock_invisible_password_placeholder')}
            />
          </label>
          {error && <p className="text-danger-text mt-2 text-sm leading-[1.45]">{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={isBusy}>
            {t('action.unlock_invisible_cancel')}
          </Button>
          <Button type="submit" size="sm" loading={isBusy} disabled={password.length === 0}>
            {t('action.unlock_invisible_submit')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

export type { InvisibleUnlockPromptModalProps }
