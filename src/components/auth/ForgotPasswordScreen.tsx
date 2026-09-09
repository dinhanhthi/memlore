import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { PasswordInput } from '../common/PasswordInput'
import { BIP39_EN } from '../../lib/bip39-wordlist-en'
import { MIN_PASSWORD_LEN } from '../../lib/passwordStrength'
import { recoverWithPassphrase } from '../../lib/tauri'
import { useSettingsStore } from '../../stores/settingsStore'
import { AuthPageCard } from '../common/AuthPageCard'
import { cn } from '../../lib/cn'

interface Props {
  /** Return to the LockScreen (or parent recovery screen) without resetting. */
  onCancel: () => void
  /** Called after a successful recover_with_passphrase (app already unlocked). */
  onSuccess?: () => void
  /** Override the cancel button label (default: auth.forgot.cancel). */
  cancelLabel?: string
}

/**
 * Offline "Forgot password" reset. Reached from the LockScreen via the
 * "Forgot password?" link. Takes the 24-word recovery phrase + a new password
 * and calls `recover_with_passphrase`, which unwraps the master key from the
 * boot-file recovery slot and unlocks the app — no Google Drive required.
 *
 * Mirrors ForceRePairScreen's phrase + new-password form, but this path does
 * NOT rotate the master key: it only re-wraps the existing one under the new
 * password.
 */
export function ForgotPasswordScreen({ onCancel, onSuccess, cancelLabel }: Props) {
  const { t } = useTranslation('auth')
  const { setLocked } = useSettingsStore()

  const [phrase, setPhrase] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')

  // BIP39 validation — identical scheme to ForceRePairScreen.
  const words = useMemo(() => phrase.trim().split(/\s+/).filter(Boolean), [phrase])
  const wordCount = words.length
  const unknownWords = useMemo(() => words.filter((w) => !BIP39_EN.has(w.toLowerCase())), [words])
  const passphraseReady = wordCount === 24 && unknownWords.length === 0

  const passwordOk = [...newPassword].length >= MIN_PASSWORD_LEN
  const passwordsMatch = newPassword === confirmPassword
  const canSubmit =
    passphraseReady && passwordOk && passwordsMatch && confirmPassword.length > 0 && !isBusy

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setIsBusy(true)
    try {
      await recoverWithPassphrase(phrase.trim().toLowerCase(), newPassword)
      // Backend has loaded the master key and swapped in the real connection.
      // Mirror the unlocked state so App.tsx leaves the lock flow.
      setLocked(false)
      onSuccess?.()
    } catch (err) {
      // Tauri rejects with a plain (English) string. Map the stable,
      // user-actionable backend conditions to their localized strings so
      // non-English users get a translated message:
      // - "no recovery slot on this device" — no slot was ever stored here.
      // - "cannot be repaired" — `load_for_recovery` still hard-failed (an
      //   unreadable file, or an unrecognized mode/unlock_method value —
      //   see boot_file::load_for_recovery). This happens BEFORE the phrase
      //   is even checked, so it must NOT fall into the generic
      //   "double-check your phrase" fallback below — that tells the user
      //   to retry something that can never succeed.
      // Everything else (wrong phrase, self-verify failure) collapses to the
      // localized generic fallback rather than leaking raw backend text.
      const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
      const msg = raw.includes('No recovery slot')
        ? t('forgot.no_recovery_slot')
        : raw.includes('cannot be repaired')
          ? t('forgot.boot_file_unrecoverable')
          : t('forgot.error_fallback')
      console.error('recoverWithPassphrase failed:', err)
      setError(msg)
      setIsBusy(false)
    }
  }

  return (
    <AuthPageCard className="max-w-120 p-8">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <div className="bg-accent/10 flex items-center justify-center rounded-full p-3">
          <AlertTriangle className="text-accent size-6" strokeWidth={1.75} />
        </div>
        <h1 className="font-title text-fg text-2xl font-extrabold">{t('forgot.title')}</h1>
        <p className="text-fg-muted text-sm leading-relaxed">{t('forgot.body')}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* Recovery phrase */}
        <div className="flex flex-col gap-1">
          <label className="text-fg-muted text-xs font-medium">
            {t('forgot.passphrase_label')}
          </label>
          <textarea
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value)
              setError('')
            }}
            placeholder={t('forgot.passphrase_placeholder')}
            rows={4}
            disabled={isBusy}
            className={cn(
              'border-border-default bg-app text-fg placeholder:text-fg-muted/50',
              'w-full resize-none rounded-xl border px-4 py-3 text-sm',
              'focus:border-accent/60 focus:ring-accent/30 focus:ring-2 focus:outline-none',
              'transition-colors duration-(--motion-duration-base)',
              'disabled:opacity-50',
            )}
            autoFocus
          />
          <p
            className={
              wordCount === 24 && unknownWords.length === 0
                ? 'text-success text-xs'
                : 'text-fg-muted text-xs'
            }
          >
            {t('forgot.passphrase_word_count', { count: wordCount })}
          </p>
          {unknownWords.length > 0 && (
            <p className="text-warning text-xs">
              {t('forgot.passphrase_unknown_words', { words: unknownWords.join(', ') })}
            </p>
          )}
        </div>

        {/* New password */}
        <div className="flex flex-col gap-1">
          <label className="text-fg-muted text-xs font-medium">
            {t('forgot.new_password_label')}
          </label>
          <PasswordInput
            value={newPassword}
            onChange={setNewPassword}
            placeholder={t('forgot.new_password_placeholder')}
            autoComplete="new-password"
            disabled={isBusy}
          />
        </div>

        {/* Confirm password */}
        <div className="flex flex-col gap-1">
          <label className="text-fg-muted text-xs font-medium">
            {t('forgot.confirm_password_label')}
          </label>
          <PasswordInput
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder={t('forgot.confirm_password_placeholder')}
            autoComplete="new-password"
            disabled={isBusy}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-danger-text text-xs">{t('forgot.mismatch')}</p>
          )}
        </div>

        {error && <Callout tone="danger">{error}</Callout>}

        <Button type="submit" variant="primary" loading={isBusy} disabled={!canSubmit}>
          {isBusy ? t('forgot.submitting') : t('forgot.submit')}
        </Button>

        <button
          type="button"
          onClick={onCancel}
          disabled={isBusy}
          className={cn(
            'text-fg-muted hover:text-fg mx-auto flex items-center gap-1.5 text-xs',
            'cursor-pointer transition-colors duration-(--motion-duration-base)',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <ArrowLeft className="size-3.5" />
          {cancelLabel ?? t('forgot.cancel')}
        </button>
      </form>
    </AuthPageCard>
  )
}
