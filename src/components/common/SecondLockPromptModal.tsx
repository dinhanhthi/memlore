import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { LockKeyhole } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import { useSecondLock } from '../../hooks/useSecondLock'

interface SecondLockPromptModalProps {
  open: boolean
  onClose: () => void
  title: string
  /** Optional body copy under the title. Omitted when empty/undefined. */
  description?: string
  mode: 'unlock-session' | 'confirm'
  onVerified: (password: string) => void | Promise<void>
}

export function SecondLockPromptModal({
  open,
  onClose,
  title,
  description,
  mode,
  onVerified,
}: SecondLockPromptModalProps) {
  const { t } = useTranslation('editor')
  const { unlock, verifyPassword } = useSecondLock(false)
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

    const trimmed = password.trim()
    if (trimmed.length === 0) {
      setError(
        t('second_lock_prompt.error_required', {
          defaultValue: 'Enter the second-lock password.',
        }),
      )
      return
    }

    setIsBusy(true)
    setError(null)
    try {
      const ok = mode === 'unlock-session' ? await unlock(trimmed) : await verifyPassword(trimmed)
      if (!ok) {
        setError(t('second_lock_prompt.error_incorrect', { defaultValue: 'Incorrect password.' }))
        return
      }
      await onVerified(trimmed)
      setPassword('')
      onClose()
    } finally {
      setIsBusy(false)
    }
  }

  const primaryLabel =
    mode === 'unlock-session'
      ? t('second_lock_prompt.unlock', { defaultValue: 'Unlock' })
      : t('second_lock_prompt.confirm', { defaultValue: 'Confirm' })

  const passwordPlaceholder = t('second_lock_prompt.password_placeholder', {
    defaultValue: 'Second-lock password',
  })
  const showDescription = typeof description === 'string' && description.trim().length > 0

  return (
    <Modal onClose={handleClose} maxWidth={420} disableEsc={isBusy} disableBackdrop={isBusy}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Modal.Header className="py-4">
          <div className="flex items-center justify-center gap-2">
            <LockKeyhole className="text-accent size-6" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="font-title text-lg font-semibold">{title}</div>
              {showDescription && (
                <p className="text-fg-muted mt-1.5 text-sm leading-[1.55]">{description}</p>
              )}
            </div>
          </div>
        </Modal.Header>
        <Modal.Body fitContent className="p-4!">
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              if (error) setError(null)
            }}
            disabled={isBusy}
            aria-label={passwordPlaceholder}
            className="border-border-default bg-surface-hi text-fg placeholder:text-fg-muted focus:border-accent h-10 w-full rounded-xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
            placeholder={passwordPlaceholder}
          />
          {error && <p className="text-danger-text mt-2 text-sm leading-[1.45]">{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={isBusy}>
            {t('second_lock_prompt.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="submit" size="sm" loading={isBusy} disabled={password.trim().length === 0}>
            {primaryLabel}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

export type { SecondLockPromptModalProps }
