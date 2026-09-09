import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { PasswordInput } from '../common/PasswordInput'
import { IconCustom } from '../common/IconCustom'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { ForgotPasswordScreen } from './ForgotPasswordScreen'
import { AuthPageCard } from '../common/AuthPageCard'
import { cn } from '../../lib/cn'

/// LockScreen renders ONLY in password-locked mode. Device mode never
/// shows this screen — the key is loaded from the OS keychain at startup.
///
/// There is no "Create password" form here anymore. Fresh installs start in
/// device mode and land directly in the journal. To add a password, the user
/// goes to Settings → "Lock Journal".
export function LockScreen() {
  const { t } = useTranslation('auth')
  const { isBiometricAvailable, isBiometricEnabled, unlock, unlockWithBiometric } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isBiometricLoading, setIsBiometricLoading] = useState(false)
  const [showForgot, setShowForgot] = useState(false)

  // In unlock mode we accept anything non-trivial and let the backend judge.
  const canSubmit = password.length >= 1 && !isLoading && !isBiometricLoading

  // Touch ID shows when the backend confirms availability and the user has
  // previously enabled biometric.
  const showBiometric = isBiometricAvailable && isBiometricEnabled

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const result = await unlock(password)
      if (!result.success) {
        setError(t('lock.invalid_password'))
        setPassword('')
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleBiometricClick = async () => {
    setError('')
    setIsBiometricLoading(true)
    try {
      const result = await unlockWithBiometric()
      if (!result.success) {
        setError(result.error || t('lock.biometric_failed'))
      }
    } finally {
      setIsBiometricLoading(false)
    }
  }

  const buttonLabel = isLoading ? t('lock.unlocking') : t('lock.unlock')

  // The recovery-phrase reset flow takes over the whole screen. On success it
  // unlocks the app; on cancel it returns here.
  if (showForgot) {
    return <ForgotPasswordScreen onCancel={() => setShowForgot(false)} />
  }

  return (
    <AuthPageCard data-testid="lock-card" className="max-w-100 p-10">
      {/* Logo + headline */}
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <img
          src={
            password.length > 0
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
        <h1 className="font-title text-fg text-2xl font-extrabold">{t('lock.welcome_back')}</h1>
        <p className="text-fg-muted text-sm">{t('lock.encrypted_device')}</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder={t('lock.password_placeholder')}
          disabled={isLoading || isBiometricLoading}
          autoFocus
          autoComplete="current-password"
        />

        {error && <Callout tone="danger">{error}</Callout>}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={isLoading}
          disabled={!canSubmit}
          className="mx-auto w-fit justify-center px-6"
        >
          {buttonLabel}
        </Button>

        {showBiometric && (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={handleBiometricClick}
            loading={isBiometricLoading}
            disabled={isLoading || isBiometricLoading}
            icon={<IconCustom name="Biometric" size={16} />}
            className="mx-auto w-fit justify-center px-6"
          >
            {isBiometricLoading ? t('lock.biometric_waiting') : t('lock.biometric_unlock')}
          </Button>
        )}
      </form>

      {/* Footer — offline password reset via the 24-word recovery phrase.
            If this device has no stored recovery slot, the reset screen says so. */}
      <button
        type="button"
        onClick={() => {
          setError('')
          setShowForgot(true)
        }}
        disabled={isLoading || isBiometricLoading}
        className={cn(
          'text-fg-muted hover:text-fg mt-6 w-full text-center text-xs',
          'cursor-pointer transition-colors duration-(--motion-duration-base)',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {t('lock.forgot_password_link')}
      </button>
    </AuthPageCard>
  )
}
