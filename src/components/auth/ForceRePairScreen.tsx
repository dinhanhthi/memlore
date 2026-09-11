import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BIP39_EN } from '../../lib/bip39-wordlist-en'
import { cn } from '../../lib/cn'
import { MIN_PASSWORD_LEN } from '../../lib/passwordStrength'
import { completeForceRePair } from '../../lib/tauri'
import { useStaleForceRePairRecheck } from '../../hooks/useStaleForceRePairRecheck'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSyncStore } from '../../stores/syncStore'
import { AuthPageCard } from '../common/AuthPageCard'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { DriveReconnectForm } from './DriveReconnectForm'
import { PasswordInput } from '../common/PasswordInput'
import { SlideOverPanel } from '../common/SlideOverPanel'

interface Props {
  onCompleted: () => void
}

/**
 * Full-screen re-pair flow, shown when the vault was ROTATED from another device
 * (reason `vault_rotated`) and this device's slot is no longer valid. The 24-word
 * phrase is the only way forward: this device's key material cannot unwrap the
 * new cloud keyring. There is no cancel — the user must re-pair or uninstall.
 *
 * A failed keyring CHECK (reason `keyring_check_inconclusive`) routes to
 * `ReconnectDriveScreen` instead — the phrase cannot fix a dead token, and
 * asking for it there produces a false "vault may be corrupted" scare.
 */
export function ForceRePairScreen({ onCompleted }: Props) {
  const { t } = useTranslation('auth')
  const { setLocked, setEncryptionMode } = useSettingsStore()

  const [phrase, setPhrase] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const [explainerOpen, setExplainerOpen] = useState(false)
  // Trigger that opened the explainer — focus is restored here on close.
  const explainerTriggerRef = useRef<HTMLButtonElement>(null)

  // Drive reconnect escape hatch: the mnemonic re-pair itself needs a live Drive
  // session, so an expired refresh token would otherwise dead-end this screen.
  // Collapsed by default — the phrase is the expected action here.
  const [reconnectOpen, setReconnectOpen] = useState(false)

  useStaleForceRePairRecheck(onCompleted)

  // BIP39 validation
  const words = useMemo(() => phrase.trim().split(/\s+/).filter(Boolean), [phrase])
  const wordCount = words.length
  const unknownWords = useMemo(() => words.filter((w) => !BIP39_EN.has(w.toLowerCase())), [words])
  const passphraseReady = wordCount === 24 && unknownWords.length === 0

  // Password validation
  const passwordOk = [...newPassword].length >= MIN_PASSWORD_LEN
  const passwordsMatch = newPassword === confirmPassword
  // `!reconnectOpen` keeps the two recovery flows mutually exclusive — a re-pair
  // (PRAGMA rekey + cloud writes) must never run while the reconnect flow is
  // mid-OAuth touching the same DB/session state.
  const canSubmit =
    passphraseReady &&
    passwordOk &&
    passwordsMatch &&
    confirmPassword.length > 0 &&
    !isBusy &&
    !reconnectOpen

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setIsBusy(true)
    try {
      await completeForceRePair(phrase.trim().toLowerCase(), newPassword)
      // The backend has loaded the key into memory. Mirror that in the
      // Zustand store so App.tsx skips LockScreen after clearForceRePair().
      setEncryptionMode('password')
      setLocked(false)
      // Refresh the sync status snapshot in syncStore. Without this, the
      // status the store cached at app init still says "no provider /
      // sync disabled" — even though persist_connect_settings wrote
      // sync_provider=gdrive + sync_enabled=true earlier in the
      // gdrive_complete_connect flow. The UI's "Enable sync" toggle reads
      // status.provider for its `disabled` prop, so the user sees a frozen
      // disabled toggle until the next status event fires.
      await useSyncStore.getState().refresh()
      onCompleted()
    } catch (err) {
      // Tauri rejects with a plain string (not Error). Preserve the backend
      // message so the user can see WHY it failed (wrong phrase vs. cloud
      // vault inconsistent vs. session reconstruction failed, etc.) instead
      // of collapsing every failure to a generic "check your phrase". The
      // backend already maps wrong-phrase to a generic AES-GCM auth failure
      // for security, so this does not leak more than intended.
      const msg =
        typeof err === 'string'
          ? err
          : err instanceof Error
            ? err.message
            : t('force_re_pair.error_fallback')
      console.error('completeForceRePair failed:', err)
      setError(msg)
      setIsBusy(false)
    }
  }

  return (
    <>
      <AuthPageCard className="max-w-120 p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="bg-danger/10 flex items-center justify-center rounded-full p-3">
            <AlertTriangle className="text-danger size-6" strokeWidth={1.75} />
          </div>
          <h1 className="font-title text-fg text-2xl font-extrabold">{t('force_re_pair.title')}</h1>
          {/* Short, action-oriented body. The reassurance/nuance (mnemonic is the
              security boundary, old local password is replaced, must be the
              ORIGINAL vault phrase) lives behind the "Learn more" side panel to
              keep this screen scannable. */}
          <p className="text-fg-muted text-sm leading-relaxed">
            {t('force_re_pair.body')}{' '}
            <button
              ref={explainerTriggerRef}
              type="button"
              onClick={() => setExplainerOpen(true)}
              className={cn(
                'text-accent inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline',
                'rounded-sm',
              )}
            >
              {t('force_re_pair.learn_more_link')}
              <ArrowRight className="size-3.5 shrink-0" strokeWidth={1.75} />
            </button>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {/* Recovery phrase */}
          <div className="flex flex-col gap-1">
            <label className="text-fg-muted text-xs font-medium">
              {t('force_re_pair.passphrase_label')}
            </label>
            <textarea
              value={phrase}
              onChange={(e) => {
                setPhrase(e.target.value)
                setError('')
              }}
              placeholder={t('force_re_pair.passphrase_placeholder')}
              rows={4}
              disabled={isBusy}
              className={cn(
                'border-border-default bg-app text-fg placeholder:text-fg-muted/50',
                'w-full resize-none rounded-xl border px-4 py-3 text-sm',
                'focus:border-accent/60 focus:outline-none',
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
              {t('force_re_pair.passphrase_word_count', { count: wordCount })}
            </p>
            {unknownWords.length > 0 && (
              <p className="text-warning text-xs">
                {t('force_re_pair.passphrase_unknown_words', { words: unknownWords.join(', ') })}
              </p>
            )}
          </div>

          {/* New password */}
          <div className="flex flex-col gap-1">
            <label className="text-fg-muted text-xs font-medium">
              {t('force_re_pair.new_password_label')}
            </label>
            <PasswordInput
              value={newPassword}
              onChange={setNewPassword}
              placeholder={t('force_re_pair.new_password_placeholder')}
              autoComplete="new-password"
              disabled={isBusy}
            />
          </div>

          {/* Confirm password */}
          <div className="flex flex-col gap-1">
            <label className="text-fg-muted text-xs font-medium">
              {t('force_re_pair.confirm_password_label')}
            </label>
            <PasswordInput
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder={t('force_re_pair.confirm_password_placeholder')}
              autoComplete="new-password"
              disabled={isBusy}
            />
            {confirmPassword.length > 0 && !passwordsMatch && (
              <p className="text-danger-text text-xs">{t('force_re_pair.mismatch')}</p>
            )}
          </div>

          {error && <Callout tone="danger">{error}</Callout>}

          <Button
            className="mx-auto w-fit px-6"
            type="submit"
            variant="primary"
            loading={isBusy}
            disabled={!canSubmit}
          >
            {isBusy ? t('force_re_pair.submitting') : t('force_re_pair.submit')}
          </Button>
        </form>

        {/* Drive reconnect escape hatch — see the state block above for why. */}
        <div className="border-border-default mt-6 border-t pt-4">
          {!reconnectOpen ? (
            <p className="text-fg-muted text-center text-xs">
              {t('force_re_pair.reconnect.prompt')}{' '}
              <button
                type="button"
                onClick={() => setReconnectOpen(true)}
                className={cn(
                  'text-accent font-medium underline-offset-2 hover:underline',
                  'rounded-sm',
                )}
              >
                {t('force_re_pair.reconnect.toggle')}
              </button>
            </p>
          ) : (
            <DriveReconnectForm
              hint={t('force_re_pair.reconnect.hint')}
              onResolved={onCompleted}
              stillRequiredMessage={t('force_re_pair.reconnect.still_required')}
              disabled={isBusy}
              onCancel={() => setReconnectOpen(false)}
            />
          )}
        </div>
      </AuthPageCard>

      {/* "Learn more" explainer — slide-in side panel. Holds the nuance moved
          out of the (now shortened) modal body. */}
      <SlideOverPanel
        open={explainerOpen}
        onClose={() => setExplainerOpen(false)}
        title={t('force_re_pair.explainer.title')}
        closeLabel={t('force_re_pair.explainer.close')}
        triggerRef={explainerTriggerRef}
      >
        <div className="flex flex-col gap-1.5">
          <p className="text-fg text-xs font-semibold tracking-wide uppercase">
            {t('force_re_pair.explainer.which_phrase_title')}
          </p>
          <p className="text-fg-muted text-sm leading-relaxed">
            {t('force_re_pair.explainer.which_phrase_body')}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-fg text-xs font-semibold tracking-wide uppercase">
            {t('force_re_pair.explainer.new_password_title')}
          </p>
          <p className="text-fg-muted text-sm leading-relaxed">
            {t('force_re_pair.explainer.new_password_body')}
          </p>
        </div>
      </SlideOverPanel>
    </>
  )
}
