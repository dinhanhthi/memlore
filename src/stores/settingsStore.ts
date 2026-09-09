import { create } from 'zustand'

/**
 * Encryption mode. `null` means "not yet probed" (before first backend fetch).
 * - `'unset'`    — no mode chosen yet; fresh install, onboarding pending.
 * - `'password'` — password-locked; app shows LockScreen until unlocked.
 */
export type EncryptionMode = 'unset' | 'password' | null

interface SettingsState {
  isLocked: boolean
  /** Current encryption mode, or `null` before the first backend probe. */
  encryptionMode: EncryptionMode
  isBiometricEnabled: boolean
  setLocked: (locked: boolean) => void
  setEncryptionMode: (mode: EncryptionMode) => void
  setBiometricEnabled: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  // Default to `false` (not locked) so that in device mode the reconcile effect
  // can succeed without flipping to a spurious lock screen. The reconcile effect
  // in useAuth will set `isLocked = true` for password mode if the key is not
  // yet loaded. See useAuth.ts for the reconcile logic.
  isLocked: false,
  encryptionMode: null,
  isBiometricEnabled: false,
  setLocked: (locked) => set({ isLocked: locked }),
  setEncryptionMode: (mode) => set({ encryptionMode: mode }),
  setBiometricEnabled: (enabled) => set({ isBiometricEnabled: enabled }),
}))
