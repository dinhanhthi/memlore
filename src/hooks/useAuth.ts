import { useCallback, useEffect, useState } from 'react'
import * as tauri from '../lib/tauri'
import { lockApp } from '../lib/lock'
import { useSettingsStore } from '../stores/settingsStore'
import type { EncryptionMode } from '../lib/tauri'

/// `useAuth` owns the app-lock + encryption-key lifecycle.
///
/// ## Encryption mode model
///
/// The journal is always encrypted, so the backend only ever reports `'unset'`
/// (no vault yet) or `'password'`. `encryptionMode` is the source of truth and
/// maps to three UI states:
///
/// - `null`        → not yet probed (before first fetch). Render nothing / spinner.
/// - `'unset'`     → fresh install, no vault yet. Render WelcomeScreen.
/// - `'password'`  + backend key not loaded → locked. Render LockScreen.
/// - `'password'`  + backend key loaded → unlocked. Render main app.
///
/// Separately, `isBootFileCorrupt` is true when startup detected an invalid
/// boot sidecar. That path must never route to FirstLaunch; App shows a
/// dedicated recovery screen and reuses ForgotPassword (24-word phrase).
///
/// ## Reconcile logic
///
/// On mount, `useAuth` calls `getStartupMode`, `getEncryptionMode`, and
/// `isEncryptionInitialized`:
/// - `boot_file_corrupt` → recovery UI; `needsOnboarding` stays false.
/// - `'unset'` → onboarding needed. Stays unlocked; `needsOnboarding` is true.
/// - `'password'` + key not loaded → `isLocked = true`.
/// - `'password'` + key loaded → `isLocked = false`.
/// - On any error → fail safe to locked.
export function useAuth() {
  const {
    isLocked,
    encryptionMode,
    isBiometricEnabled,
    setLocked,
    setEncryptionMode,
    setBiometricEnabled,
  } = useSettingsStore()

  // Platform availability is a pure probe result (never persists). Kept in
  // local hook state rather than the settings store so a stale rehydrated
  // value can't claim Touch ID on a machine that doesn't have it.
  const [isBiometricAvailable, setBiometricAvailable] = useState(false)
  const [hasReconciled, setHasReconciled] = useState(false)
  // True when `startup_init` returned BootFileCorrupt. Cleared after a
  // successful `recover_with_passphrase` so App can leave the recovery screen.
  const [isBootFileCorrupt, setBootFileCorrupt] = useState(false)

  // `encryptionMode === 'unset'` after reconcile means onboarding is needed.
  // Boot-file-corrupt never reports true onboarding — vault exists on disk.
  const needsOnboarding = hasReconciled && encryptionMode === 'unset' && !isBootFileCorrupt

  // On mount: reconcile the UI lock state with the backend's source of truth.
  useEffect(() => {
    // Under React 18 StrictMode the effect runs twice in dev. The `cancelled`
    // flag prevents concurrent reconciles from racing and guards against
    // setState-after-unmount warnings.
    let cancelled = false
    const reconcile = async () => {
      try {
        const [startupMode, mode, backendInitialized] = await Promise.all([
          tauri.getStartupMode(),
          tauri.getEncryptionMode(),
          tauri.isEncryptionInitialized(),
        ])
        if (cancelled) return

        // Update the authoritative `encryptionMode` in the store.
        setEncryptionMode(mode)

        if (startupMode === 'boot_file_corrupt') {
          // Vault is intact; boot sidecar is not. Recovery UI owns the path —
          // do not treat as FirstLaunch even if encryption_mode probe fails.
          setBootFileCorrupt(true)
          setLocked(true)
        } else if (mode === 'password') {
          if (!backendInitialized) {
            setLocked(true)
          }
          // else: key already loaded (e.g. biometric unlock happened) — stay unlocked.
        } else {
          // 'unset' → no vault yet, so no lock screen.
          setLocked(false)
        }
      } catch (error) {
        if (cancelled) return
        console.error('Failed to reconcile auth state with backend:', error)
        setLocked(true)
      } finally {
        if (!cancelled) setHasReconciled(true)
      }

      if (cancelled) return

      try {
        const available = await tauri.isBiometricAvailable()
        if (cancelled) return
        setBiometricAvailable(available)
        if (available) {
          const enabledBiom = await tauri.isBiometricUnlockEnabled()
          if (cancelled) return
          setBiometricEnabled(enabledBiom)
        } else {
          setBiometricEnabled(false)
        }
      } catch (error) {
        if (cancelled) return
        console.warn('Failed to probe biometric capability:', error)
        setBiometricAvailable(false)
        setBiometricEnabled(false)
      }
    }
    void reconcile()
    return () => {
      cancelled = true
    }
  }, [setEncryptionMode, setLocked, setBiometricEnabled])

  // Unlock with password. Also derives/unwraps the encryption key into backend state.
  // `initializeEncryption` validates the password via AES-GCM tag check when
  // unwrapping the KEK — a wrong password produces "Invalid password" from Rust.
  const unlock = useCallback(
    async (password: string) => {
      try {
        await tauri.initializeEncryption(password)
        setLocked(false)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unlock failed'
        return { success: false, error: message }
      }
    },
    [setLocked],
  )

  // Lock the app. Also zeroizes the encryption key in backend state.
  // Delegates to `lockApp` from `src/lib/lock` — single source of truth.
  const lock = useCallback(async () => {
    await lockApp()
  }, [])

  // When the window closes (user closes app, reloads, or the process
  // receives a tab-close), do a best-effort final zeroize of the in-memory key.
  useEffect(() => {
    const handler = () => {
      tauri.lockEncryption().catch(() => {
        /* nothing useful we can do here — process is shutting down */
      })
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Change password. The backend keeps the entry key but re-wraps it with the
  // new KEK. In-memory key is unchanged. No re-initialization needed.
  //
  // Side effect: the backend wipes the biometric Keychain item since the
  // stored key was bound to the old password. We mirror that by flipping
  // `isBiometricEnabled` off — user can re-enable from Settings.
  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string) => {
      try {
        await tauri.changePassword(oldPassword, newPassword)
        setBiometricEnabled(false)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to change password'
        return { success: false, error: message }
      }
    },
    [setBiometricEnabled],
  )

  // Biometric unlock — triggers the macOS Touch ID prompt. On failure we stay
  // locked so the user can fall back to password entry.
  const unlockWithBiometric = useCallback(async () => {
    try {
      await tauri.unlockWithBiometric()
      setLocked(false)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Biometric unlock failed'
      return { success: false, error: message }
    }
  }, [setLocked])

  // Turn biometric unlock on: requires the app to be already unlocked.
  const enableBiometric = useCallback(async () => {
    try {
      await tauri.enableBiometricUnlock()
      setBiometricEnabled(true)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enable biometric'
      return { success: false, error: message }
    }
  }, [setBiometricEnabled])

  // Turn biometric unlock off: wipes the Keychain item. Idempotent on the
  // backend — a missing item is not an error.
  const disableBiometric = useCallback(async () => {
    try {
      await tauri.disableBiometricUnlock()
      setBiometricEnabled(false)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to disable biometric'
      return { success: false, error: message }
    }
  }, [setBiometricEnabled])

  // Rotate the master key without revoking a specific device. The recovery
  // phrase is UNCHANGED (reuse-current model) — the caller must supply the
  // current 24-word phrase so it can be written to _recovery.json.
  const rotateMasterKey = useCallback(
    async (
      currentPassword: string,
      recoveryMnemonic: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        await tauri.rotateMasterKey(currentPassword, recoveryMnemonic)
        return { success: true }
      } catch (error) {
        const message =
          typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : 'Failed to rotate master key'
        return { success: false, error: message }
      }
    },
    [],
  )

  // Reset the recovery phrase (Flow G): mint a NEW master key AND a NEW 24-word
  // phrase together, forward-only. The returned mnemonic is the ONLY surviving
  // copy — the backend clears the rotation stash in the same transaction that
  // finalises the reset, so `getPendingRotationRecovery` can never return it.
  // The caller must reveal `mnemonic` right away (there is no relaunch re-reveal).
  const resetRecoveryPhrase = useCallback(
    async (
      currentPassword: string,
    ): Promise<{ success: boolean; error?: string; mnemonic?: string }> => {
      try {
        const mnemonic = await tauri.resetRecoveryPhrase(currentPassword)
        return { success: true, mnemonic }
      } catch (error) {
        const message =
          typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : 'Failed to reset recovery phrase'
        return { success: false, error: message }
      }
    },
    [],
  )

  // Confirm that the user has saved the new recovery phrase. This clears the
  // stashed mnemonic from the database so it is no longer returned by
  // `getPendingRotationRecovery`.
  const confirmRotationRecoverySaved = useCallback(async (): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      await tauri.confirmRotationRecoverySaved()
      return { success: true }
    } catch (error) {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Failed to confirm recovery saved'
      return { success: false, error: message }
    }
  }, [])

  // Retrieve the pending rotation recovery phrase, if any.
  // Swallows errors and returns null — this is a best-effort getter used on
  // the reveal/relaunch path; if it fails the UI simply shows nothing to
  // re-reveal rather than crashing.
  const getPendingRotationRecovery = useCallback(async (): Promise<string | null> => {
    try {
      return await tauri.getPendingRotationRecovery()
    } catch {
      return null
    }
  }, [])

  const clearBootFileCorrupt = useCallback(() => {
    setBootFileCorrupt(false)
  }, [])

  return {
    isLocked,
    /** Authoritative encryption mode from the backend. `null` until first probe. */
    encryptionMode: encryptionMode as EncryptionMode | null,
    /** True when `encryptionMode === 'unset'` after reconcile — onboarding needed. */
    needsOnboarding,
    /** True when startup found an invalid boot file; vault is intact. */
    isBootFileCorrupt,
    /** Clear after successful phrase recovery so App leaves the recovery screen. */
    clearBootFileCorrupt,
    hasReconciled,
    isBiometricAvailable,
    isBiometricEnabled,
    unlock,
    lock,
    changePassword,
    unlockWithBiometric,
    enableBiometric,
    disableBiometric,
    rotateMasterKey,
    resetRecoveryPhrase,
    confirmRotationRecoverySaved,
    getPendingRotationRecovery,
  }
}
