import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForceRePairStore } from '../../hooks/useForceRePair'
import { gdriveBeginConnect, gdriveCompleteConnect, recheckForceRePair } from '../../lib/tauri'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { PasswordInput } from '../common/PasswordInput'

interface Props {
  /**
   * Optional contextual note above the password field. Omit when the host
   * screen already shows a description (e.g. `ReconnectDriveScreen`).
   */
  hint?: string
  /** The reconnect verified the vault and the backend cleared the flag. */
  onResolved: () => void
  /**
   * Shown when the reconnect succeeded but the flag still stands. On a host with
   * no phrase form this is near-unreachable: a `vault_rotated` outcome re-routes
   * to `ForceRePairScreen` via the store before it can paint. It still fires for
   * a flag that survives an otherwise-healthy reconnect.
   */
  stillRequiredMessage: string
  /** Blocks the form while the caller runs a conflicting flow (e.g. re-pair). */
  disabled?: boolean
  /**
   * Collapses a hosting hatch. Rendered as a Cancel button that this component
   * disables mid-OAuth — the host gates its own conflicting flow on the hatch
   * staying open, so letting the user collapse it mid-flight would unblock a
   * re-pair that must not run concurrently with the connect.
   */
  onCancel?: () => void
}

/**
 * Google Drive reconnect flow, shared by `ReconnectDriveScreen` (where it is the
 * whole screen) and `ForceRePairScreen` (where it is a collapsed escape hatch).
 *
 * Both the vault check and the mnemonic re-pair need a live Drive session, so a
 * device with an expired refresh token has no route out of either screen without
 * this. `gdrive_complete_connect` verifies the current local password in
 * password mode, so the form collects it.
 *
 * Self-escalating: when the reconnect reveals a genuine peer rotation, the
 * backend returns `needs_force_re_pair` and this pushes the reason into
 * `useForceRePairStore` — which re-routes `App` to `ForceRePairScreen`. That is
 * what lets `ReconnectDriveScreen` omit the recovery phrase field without ever
 * dead-ending a user whose vault really did move.
 */
export function DriveReconnectForm({
  hint,
  onResolved,
  stillRequiredMessage,
  disabled = false,
  onCancel,
}: Props) {
  const { t } = useTranslation('auth')
  const [password, setPassword] = useState('')
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const canSubmit = password.length > 0 && !isReconnecting && !disabled

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError('')
    setInfo('')
    setIsReconnecting(true)
    try {
      const begin = await gdriveBeginConnect()
      await openUrl(begin.authUrl)
      const outcome = await gdriveCompleteConnect(begin.sessionId, password)
      if (outcome.outcome === 'needs_force_re_pair') {
        // Token persisted, vault genuinely rotated — re-pair is now possible.
        // Routes to ForceRePairScreen when the caller had no phrase form.
        useForceRePairStore.getState().setForceRePair(outcome.reason)
        setInfo(stillRequiredMessage)
        return
      }
      if (outcome.outcome !== 'ready') {
        // Cloud vault is in a state this screen cannot recover from (mode
        // mismatch, V1 wipe). Surface it rather than pretend.
        setError(t('force_re_pair.reconnect.unexpected_outcome', { outcome: outcome.outcome }))
        return
      }
      // Connected and the fingerprint check passed inside the connect flow —
      // but the connect flow never clears the flag itself (see gdrive.rs), so
      // run the recheck to clear a stale flag and dismiss.
      const cleared = await recheckForceRePair()
      if (cleared) {
        onResolved()
      } else {
        setInfo(stillRequiredMessage)
      }
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
      console.error('Drive reconnect failed:', err)
      setError(msg)
    } finally {
      // Clear the plaintext password on every exit path (success AND error) —
      // it is a secret; do not let it linger in component state for a retry.
      setPassword('')
      setIsReconnecting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {hint && <p className="text-fg-muted text-xs leading-relaxed">{hint}</p>}
      <PasswordInput
        value={password}
        onChange={setPassword}
        placeholder={t('force_re_pair.reconnect.password_placeholder')}
        autoComplete="current-password"
        disabled={isReconnecting || disabled}
      />

      {info && <Callout tone="warning">{info}</Callout>}

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="mt-4 flex items-center justify-center gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Never let the user collapse the hatch mid-OAuth: the host gates
            // its own re-pair on this staying open, and the in-flight connect
            // cannot be aborted — only hidden.
            disabled={isReconnecting}
            onClick={onCancel}
          >
            {t('force_re_pair.reconnect.cancel')}
          </Button>
        )}
        <Button
          className="w-fit px-6"
          type="submit"
          variant="primary"
          loading={isReconnecting}
          disabled={!canSubmit}
        >
          {isReconnecting
            ? t('force_re_pair.reconnect.submitting')
            : t('force_re_pair.reconnect.submit')}
        </Button>
      </div>
    </form>
  )
}
