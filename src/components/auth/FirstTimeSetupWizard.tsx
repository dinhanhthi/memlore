import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useFirstTimeSetup } from '../../hooks/useFirstTimeSetup'
import type { UnlockMethod } from '../../lib/tauri'
import { UnlockMethodStep } from './UnlockMethodStep'
import { SetPasswordScreen } from './SetPasswordScreen'
import { RecoveryPassphraseRevealScreen } from './RecoveryPassphraseRevealScreen'
import { RecoveryPassphraseConfirmScreen } from './RecoveryPassphraseConfirmScreen'

interface Props {
  /** Called when the full setup is complete (stage === 'done'). */
  onSetupComplete: () => void
  /** Called when the user backs out of the wizard entirely. */
  onCancel: () => void
  /**
   * Optional Drive session_id from WelcomeScreen (cloud-empty-prompt path).
   * When supplied, confirmFirstTimeSetup will consume the pending Drive
   * session and persist the four sync settings atomically with the password flip.
   */
  sessionId?: string
}

/**
 * FirstTimeSetupWizard orchestrates first-time setup. The journal is **always
 * encrypted** — the wizard is entered directly, with no mode choice before it.
 *
 * Step order for the always-encrypted model (Phase 6):
 *
 *   UnlockMethodStep  →  SetPasswordScreen  →  RecoveryPassphraseRevealScreen
 *                     →  RecoveryPassphraseConfirmScreen  →  done
 *
 * The optional recovery-sheet download now lives *on* the reveal screen (a
 * confirm modal beside "Copy phrase"), not as a separate step — so confirming
 * the phrase is the final action and it gates completion directly.
 *
 * A password is collected on every path — even when the user picks OS unlock —
 * because it is the guaranteed fallback when Touch ID is cancelled or the
 * keystore item is invalidated.
 *
 * The wizard also handles crash-recovery: if a pending setup row exists in the
 * DB on mount (the user was killed between reveal and confirm), the hook's
 * useEffect will fire `BEGIN_SUCCESS` with `isResumed=true` and we jump
 * directly to the reveal screen.
 *
 * The parent (WelcomeScreen or App.tsx) is responsible for rendering this
 * component; the wizard owns the hook state machine.
 */
export function FirstTimeSetupWizard({ onSetupComplete, onCancel, sessionId }: Props) {
  const setEncryptionMode = useSettingsStore((s) => s.setEncryptionMode)
  const { stage, beginSetup, proceedToConfirm, cancelSetup, submitConfirmation } =
    useFirstTimeSetup(sessionId)
  // null = the picker (step 0) has not been answered yet. A crash-resumed setup
  // jumps straight to `mnemonic_revealed` and never sees the picker, so the
  // confirm call below falls back to 'password' — never a hard requirement.
  const [unlockMethod, setUnlockMethod] = useState<UnlockMethod | null>(null)

  // When setup is done, flip the encryption mode in the store so the app routes
  // past onboarding. Do NOT flip earlier (e.g. on beginSetup): that would mark
  // the user "logged in" while the pending row still exists.
  useEffect(() => {
    if (stage.kind === 'done') {
      setEncryptionMode('password')
      onSetupComplete()
    }
  }, [stage.kind, setEncryptionMode, onSetupComplete])

  const handleCancel = async () => {
    await cancelSetup()
    onCancel()
  }

  // Step 0: unlock-method picker. Only gates the very start of the flow —
  // a resumed setup (stage already past `idle`) must never be sent back here.
  if (unlockMethod === null && stage.kind === 'idle') {
    return <UnlockMethodStep onSelected={setUnlockMethod} onCancel={onCancel} />
  }

  // Back from the password screen returns to the picker, which is now the
  // wizard's first screen; the picker's own back leaves the wizard.
  const backToUnlockMethod = () => setUnlockMethod(null)

  // Step 1: password entry
  if (stage.kind === 'idle' || stage.kind === 'password_entered' || stage.kind === 'submitting') {
    return (
      <SetPasswordScreen
        onPasswordSubmitted={(password, deviceName) => beginSetup(password, deviceName)}
        onCancel={backToUnlockMethod}
        isSubmitting={stage.kind === 'submitting'}
      />
    )
  }

  // Step 2: reveal the 24-word mnemonic
  if (stage.kind === 'mnemonic_revealed') {
    return (
      <RecoveryPassphraseRevealScreen
        mnemonic={stage.mnemonic}
        isResumed={stage.isResumed}
        onContinue={proceedToConfirm}
        onCancel={handleCancel}
      />
    )
  }

  // Step 3: 4-word confirmation challenge
  if (stage.kind === 'confirm_pending') {
    return (
      <RecoveryPassphraseConfirmScreen
        challengeIndices={stage.challengeIndices}
        error={stage.error}
        onSubmit={(answers, password) =>
          // `?? 'password'` is load-bearing: a crash-resumed setup skips the
          // picker, and password-only is the one method that always works.
          submitConfirmation(answers, password, unlockMethod ?? 'password')
        }
        onCancel={handleCancel}
      />
    )
  }

  // Error state (begin failed with a hard error, not a retry-able confirm error)
  if (stage.kind === 'error') {
    return (
      <SetPasswordScreen
        onPasswordSubmitted={(password, deviceName) => beginSetup(password, deviceName)}
        onCancel={onCancel}
        setupError={stage.message}
      />
    )
  }

  // stage.kind === 'done': effect above fires onSetupComplete(); render null briefly
  return null
}
