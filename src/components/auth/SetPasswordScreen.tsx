import { useState, useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { PasswordInput } from '../common/PasswordInput'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { MIN_PASSWORD_LEN, passwordStrength, type Strength } from '../../lib/passwordStrength'
import { AuthPageCard } from '../common/AuthPageCard'
import { cn } from '../../lib/cn'

const STRENGTH_STYLES: Record<Strength, { segments: number; color: string }> = {
  weak: { segments: 1, color: 'bg-danger' },
  fair: { segments: 2, color: 'bg-warning' },
  good: { segments: 3, color: 'bg-success' },
  strong: { segments: 4, color: 'bg-accent' },
}

interface SetPasswordScreenProps {
  /**
   * Wizard mode: called with the entered password + device name so the parent
   * can call `beginFirstTimeSetup`. The parent owns the submission spinner and
   * error display via `isSubmitting` / `setupError`. Required — this component
   * only works in wizard mode.
   */
  onPasswordSubmitted: (password: string, deviceName: string) => void

  /** When provided: renders a back button to return to the caller. */
  onCancel?: () => void

  /**
   * Wizard mode: true while the parent is awaiting `begin_first_time_setup`.
   * The submit button shows a spinner and is disabled.
   */
  isSubmitting?: boolean

  /**
   * Wizard mode: an error from the backend that should be shown inline.
   * Typically the message from a rejected `beginFirstTimeSetup`.
   */
  setupError?: string
}

// Derive a device name from the browser environment. Falls back to a generic
// string — the backend accepts any non-empty string and defaults to hostname
// when an empty string is passed. On Tauri we can't call `os.hostname()` from
// this sync context without an IPC round-trip, so we use the UA as a proxy.
function deriveDeviceName(): string {
  if (typeof navigator !== 'undefined' && navigator.platform) {
    const p = navigator.platform
    if (p.startsWith('Mac')) return 'Mac'
    if (p.startsWith('Win')) return 'Windows PC'
    if (p.startsWith('Linux')) return 'Linux PC'
  }
  return 'This device'
}

export function SetPasswordScreen({
  onPasswordSubmitted,
  onCancel,
  isSubmitting: externalSubmitting = false,
  setupError,
}: SetPasswordScreenProps) {
  const { t } = useTranslation('auth')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [confirmTouched, setConfirmTouched] = useState(false)

  const isSubmitting = externalSubmitting
  const error = setupError

  const pwLen = [...password].length
  const strength = useMemo(() => passwordStrength(password), [password])
  const mismatched = confirm.length > 0 && password !== confirm
  const canSubmit = pwLen >= MIN_PASSWORD_LEN && password === confirm

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if ([...password].length < MIN_PASSWORD_LEN || password !== confirm || isSubmitting) return
    onPasswordSubmitted(password, deriveDeviceName())
  }

  const strengthStyle = STRENGTH_STYLES[strength]

  return (
    <AuthPageCard data-testid="set-password-screen" className="max-w-120 p-8">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        {/* Same mascot as the lock screen: eyes shut while a password is typed. */}
        <img
          src={
            pwLen > 0 || confirm.length > 0
              ? '/logo-without-container/logo-straight-close-eyes-256.png'
              : '/logo-without-container/logo-straight-256.png'
          }
          width={100}
          height={100}
          className="block shrink-0"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <h1 className="font-title text-fg mb-1 text-3xl font-extrabold">
          {t('set_password.title')}
        </h1>
        <p className="text-fg-muted text-sm">{t('set_password.description')}</p>
      </div>

      {error && (
        <Callout tone="danger" className="mb-4">
          {error}
        </Callout>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="text-fg-muted text-xs font-medium">
            {t('set_password.password_label')}
          </label>
          <PasswordInput
            id="password"
            value={password}
            onChange={setPassword}
            disabled={isSubmitting}
            autoFocus
            autoComplete="new-password"
          />
          <div className="mt-1 flex items-center gap-2" data-testid="password-strength">
            <div className="flex flex-1 gap-1">
              {[1, 2, 3, 4].map((seg) => (
                <div
                  key={seg}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-[background-color] duration-(--motion-duration-base)',
                    seg <= strengthStyle.segments ? strengthStyle.color : 'bg-(--hairline-strong)',
                  )}
                />
              ))}
            </div>
            <span className="text-fg-muted text-xs">{t(`set_password.strength.${strength}`)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="confirm-password" className="text-fg-muted text-xs font-medium">
            {t('set_password.confirm_label')}
          </label>
          <PasswordInput
            id="confirm-password"
            value={confirm}
            onChange={setConfirm}
            onBlur={() => setConfirmTouched(true)}
            disabled={isSubmitting}
            autoComplete="new-password"
          />
          {confirmTouched && mismatched && (
            <p className="text-danger-text text-xs">{t('set_password.mismatch')}</p>
          )}
        </div>

        <p className="text-fg-muted text-xs">
          <Trans
            i18nKey="set_password.hint"
            ns="auth"
            values={{ count: MIN_PASSWORD_LEN }}
            components={[<strong className="font-semibold" />]}
          />
        </p>

        <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:justify-between">
          {onCancel && (
            <Button variant="ghost" size="md" onClick={onCancel} disabled={isSubmitting}>
              {t('set_password.back')}
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={isSubmitting}
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t('set_password.creating') : t('set_password.create')}
          </Button>
        </div>
      </form>
    </AuthPageCard>
  )
}
