import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAuth } from './useAuth'
import { useSettingsStore } from '../stores/settingsStore'
import * as tauri from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  isPasswordSet: vi.fn(),
  verifyPassword: vi.fn(),
  setPassword: vi.fn(),
  changePassword: vi.fn(),
  initializeEncryption: vi.fn(),
  lockEncryption: vi.fn(),
  isEncryptionInitialized: vi.fn(),
  isBiometricAvailable: vi.fn(),
  isBiometricUnlockEnabled: vi.fn(),
  enableBiometricUnlock: vi.fn(),
  disableBiometricUnlock: vi.fn(),
  unlockWithBiometric: vi.fn(),
  getEncryptionMode: vi.fn(),
  getStartupMode: vi.fn(),
  rotateMasterKey: vi.fn(),
  resetRecoveryPhrase: vi.fn(),
  confirmRotationRecoverySaved: vi.fn(),
  getPendingRotationRecovery: vi.fn(),
}))

describe('useAuth (password-only model)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(tauri.initializeEncryption).mockResolvedValue()
    vi.mocked(tauri.lockEncryption).mockResolvedValue()
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(false)
    vi.mocked(tauri.isBiometricUnlockEnabled).mockResolvedValue(false)
    vi.mocked(tauri.enableBiometricUnlock).mockResolvedValue()
    vi.mocked(tauri.disableBiometricUnlock).mockResolvedValue()
    vi.mocked(tauri.unlockWithBiometric).mockResolvedValue()
    vi.mocked(tauri.rotateMasterKey).mockResolvedValue()
    vi.mocked(tauri.resetRecoveryPhrase).mockResolvedValue('word '.repeat(24).trim())
    vi.mocked(tauri.confirmRotationRecoverySaved).mockResolvedValue()
    vi.mocked(tauri.getPendingRotationRecovery).mockResolvedValue(null)
    vi.mocked(tauri.getStartupMode).mockResolvedValue('password_locked')
    useSettingsStore.setState({
      isLocked: false,
      encryptionMode: null,
      isBiometricEnabled: false,
    })
  })

  // ─── Unset mode (fresh DB / onboarding needed) ───────────────────────────

  it('unset mode: reconcile sets encryptionMode=unset, needsOnboarding=true, isLocked=false', async () => {
    vi.mocked(tauri.getStartupMode).mockResolvedValue('first_launch')
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('unset')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(tauri.getEncryptionMode).toHaveBeenCalled()
    })

    expect(result.current.encryptionMode).toBe('unset')
    expect(result.current.needsOnboarding).toBe(true)
    expect(result.current.isLocked).toBe(false)
    expect(result.current.isBootFileCorrupt).toBe(false)
  })

  // ─── Password mode ───────────────────────────────────────────────────────

  it('password mode: key not loaded → locks', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.encryptionMode).toBe('password')
      expect(result.current.isLocked).toBe(true)
    })
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.isBootFileCorrupt).toBe(false)
  })

  it('password mode: key already loaded → stays unlocked', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))
    expect(result.current.isLocked).toBe(false)
    expect(result.current.needsOnboarding).toBe(false)
  })

  // ─── Boot file corrupt ───────────────────────────────────────────────────

  it('boot_file_corrupt: sets isBootFileCorrupt, needsOnboarding=false, isLocked=true', async () => {
    vi.mocked(tauri.getStartupMode).mockResolvedValue('boot_file_corrupt')
    // Placeholder still reports password so FirstLaunch is never chosen.
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isBootFileCorrupt).toBe(true)
    })
    expect(result.current.needsOnboarding).toBe(false)
    expect(result.current.isLocked).toBe(true)
    expect(result.current.encryptionMode).toBe('password')
  })

  it('clearBootFileCorrupt flips the flag after successful recovery', async () => {
    vi.mocked(tauri.getStartupMode).mockResolvedValue('boot_file_corrupt')
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => expect(result.current.isBootFileCorrupt).toBe(true))
    result.current.clearBootFileCorrupt()
    await waitFor(() => expect(result.current.isBootFileCorrupt).toBe(false))
  })

  // The `&& !isBootFileCorrupt` clause on `needsOnboarding` only makes a
  // difference when `encryptionMode` reads `'unset'` — e.g. if the
  // placeholder DB's seeded `encryption_mode=password` (see
  // `startup_placeholder_conn` in lib.rs) ever failed to apply, or the two
  // probes raced. Without the clause this combination would send a
  // BootFileCorrupt user into onboarding, which looks like data loss even
  // though the vault on disk is intact.
  it('boot_file_corrupt with encryptionMode=unset still does not report needsOnboarding', async () => {
    vi.mocked(tauri.getStartupMode).mockResolvedValue('boot_file_corrupt')
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('unset')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => expect(result.current.isBootFileCorrupt).toBe(true))
    expect(result.current.needsOnboarding).toBe(false)
  })

  // ─── Error handling ─────────────────────────────────────────────────────

  it('fails safe to locked when reconcile throws', async () => {
    vi.mocked(tauri.getEncryptionMode).mockRejectedValue(new Error('tauri unavailable'))

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isLocked).toBe(true)
    })
  })

  // `getStartupMode` is part of the same `Promise.all` as `getEncryptionMode`
  // / `isEncryptionInitialized` — a rejection here (e.g. the command is
  // missing or errors) must fail safe the same way a `getEncryptionMode`
  // rejection already does, not silently skip straight to an unlocked state.
  it('fails safe to locked when getStartupMode rejects', async () => {
    vi.mocked(tauri.getStartupMode).mockRejectedValue(new Error('get_startup_mode unavailable'))
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isLocked).toBe(true)
    })
  })

  // ─── Unlock with password ───────────────────────────────────────────────

  it('unlocks with correct password and initializes encryption', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.verifyPassword).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const unlockResult = await result.current.unlock('correctpass')
    expect(unlockResult.success).toBe(true)
    expect(tauri.initializeEncryption).toHaveBeenCalledWith('correctpass')
    expect(result.current.isLocked).toBe(false)
  })

  it('fails unlock with wrong password and surfaces the backend error', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.initializeEncryption).mockRejectedValue(new Error('Invalid password'))

    const { result } = renderHook(() => useAuth())

    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const unlockResult = await result.current.unlock('wrongpass')
    expect(unlockResult.success).toBe(false)
    expect(unlockResult.error).toBe('Invalid password')
    expect(tauri.initializeEncryption).toHaveBeenCalledWith('wrongpass')
  })

  // ─── Lock ───────────────────────────────────────────────────────────────

  it('locks the app and zeroizes the backend key', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    await result.current.lock()

    expect(tauri.lockEncryption).toHaveBeenCalled()
    await waitFor(() => {
      expect(result.current.isLocked).toBe(true)
    })
  })

  // ─── Change password ────────────────────────────────────────────────────

  it('changes password without re-initializing encryption', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.changePassword).mockResolvedValue()

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const changeResult = await result.current.changePassword('oldpass12', 'newpass12')
    expect(changeResult.success).toBe(true)
    expect(tauri.initializeEncryption).not.toHaveBeenCalled()
  })

  it('clears biometric-enabled flag after a successful password change', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(true)
    vi.mocked(tauri.isBiometricUnlockEnabled).mockResolvedValue(true)
    vi.mocked(tauri.changePassword).mockResolvedValue()

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isBiometricEnabled).toBe(true)
    })

    const r = await result.current.changePassword('oldpass12345', 'newpass12345')
    expect(r.success).toBe(true)
    expect(result.current.isBiometricEnabled).toBe(false)
  })

  // ─── Reset recovery phrase (Flow G) ──────────────────────────────────────

  it('reset recovery phrase: success returns the new mnemonic', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    const newPhrase = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ')
    vi.mocked(tauri.resetRecoveryPhrase).mockResolvedValue(newPhrase)

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const res = await result.current.resetRecoveryPhrase('currentpass12')
    expect(tauri.resetRecoveryPhrase).toHaveBeenCalledWith('currentpass12')
    expect(res.success).toBe(true)
    expect(res.mnemonic).toBe(newPhrase)
  })

  it('reset recovery phrase: backend rejection returns { success: false }', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.resetRecoveryPhrase).mockRejectedValue('Invalid password')

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const res = await result.current.resetRecoveryPhrase('wrongpass')
    expect(res.success).toBe(false)
    expect(res.error).toBe('Invalid password')
    expect(res.mnemonic).toBeUndefined()
  })

  // ─── Biometric unlock ────────────────────────────────────────────────────

  it('reconciles biometric availability and enabled state on mount', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(true)
    vi.mocked(tauri.isBiometricUnlockEnabled).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(tauri.isBiometricAvailable).toHaveBeenCalled()
      expect(tauri.isBiometricUnlockEnabled).toHaveBeenCalled()
    })
    expect(result.current.isBiometricAvailable).toBe(true)
    expect(result.current.isBiometricEnabled).toBe(true)
  })

  it('treats biometric as unavailable when the backend probe fails', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockRejectedValue(new Error('platform error'))

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(tauri.isBiometricAvailable).toHaveBeenCalled()
    })
    expect(result.current.isBiometricAvailable).toBe(false)
  })

  it('unlocks via biometric and marks app unlocked', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(true)
    vi.mocked(tauri.isBiometricUnlockEnabled).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(tauri.isBiometricAvailable).toHaveBeenCalled()
    })

    const r = await result.current.unlockWithBiometric()
    expect(r.success).toBe(true)
    expect(tauri.unlockWithBiometric).toHaveBeenCalled()
    expect(result.current.isLocked).toBe(false)
  })

  it('returns error and stays locked when biometric unlock fails', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(true)
    vi.mocked(tauri.isBiometricUnlockEnabled).mockResolvedValue(true)
    vi.mocked(tauri.unlockWithBiometric).mockRejectedValue(new Error('User cancelled Touch ID'))
    vi.mocked(tauri.isEncryptionInitialized).mockResolvedValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(tauri.isBiometricAvailable).toHaveBeenCalled()
    })

    const r = await result.current.unlockWithBiometric()
    expect(r.success).toBe(false)
    expect(r.error).toContain('Touch ID')
  })

  it('enables biometric and flips store flag', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(tauri.isBiometricAvailable).toHaveBeenCalled()
    })

    const r = await result.current.enableBiometric()
    expect(r.success).toBe(true)
    expect(tauri.enableBiometricUnlock).toHaveBeenCalled()
    expect(result.current.isBiometricEnabled).toBe(true)
  })

  it('disables biometric and flips store flag', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.isBiometricAvailable).mockResolvedValue(true)
    vi.mocked(tauri.isBiometricUnlockEnabled).mockResolvedValue(true)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isBiometricEnabled).toBe(true)
    })

    const r = await result.current.disableBiometric()
    expect(r.success).toBe(true)
    expect(tauri.disableBiometricUnlock).toHaveBeenCalled()
    expect(result.current.isBiometricEnabled).toBe(false)
  })

  // ─── rotateMasterKey ────────────────────────────────────────────────────

  it('rotateMasterKey: returns { success: true } when backend resolves', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.rotateMasterKey).mockResolvedValue()

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const r = await result.current.rotateMasterKey('currentpassword', 'word '.repeat(24).trim())
    expect(r.success).toBe(true)
    expect(tauri.rotateMasterKey).toHaveBeenCalledWith('currentpassword', 'word '.repeat(24).trim())
  })

  it('rotateMasterKey: returns { success: false, error } when backend rejects with Error', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.rotateMasterKey).mockRejectedValue(new Error('Invalid password'))

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const r = await result.current.rotateMasterKey('wrongpassword', 'word '.repeat(24).trim())
    expect(r.success).toBe(false)
    expect(r.error).toBe('Invalid password')
  })

  it('rotateMasterKey: surfaces plain string when Tauri rejects with a string', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.rotateMasterKey).mockRejectedValue('wrong password string')

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const r = await result.current.rotateMasterKey('wrongpassword', 'word '.repeat(24).trim())
    expect(r.success).toBe(false)
    expect(r.error).toBe('wrong password string')
  })

  // ─── confirmRotationRecoverySaved ───────────────────────────────────────

  it('confirmRotationRecoverySaved: returns { success: true } when backend resolves', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.confirmRotationRecoverySaved).mockResolvedValue()

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const r = await result.current.confirmRotationRecoverySaved()
    expect(r.success).toBe(true)
    expect(tauri.confirmRotationRecoverySaved).toHaveBeenCalled()
  })

  it('confirmRotationRecoverySaved: returns { success: false, error } when backend rejects with Error', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.confirmRotationRecoverySaved).mockRejectedValue(
      new Error('No pending rotation'),
    )

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const r = await result.current.confirmRotationRecoverySaved()
    expect(r.success).toBe(false)
    expect(r.error).toBe('No pending rotation')
  })

  it('confirmRotationRecoverySaved: surfaces plain string when Tauri rejects with a string', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.confirmRotationRecoverySaved).mockRejectedValue('no pending rotation string')

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const r = await result.current.confirmRotationRecoverySaved()
    expect(r.success).toBe(false)
    expect(r.error).toBe('no pending rotation string')
  })

  // ─── getPendingRotationRecovery ─────────────────────────────────────────

  it('getPendingRotationRecovery: returns the phrase when backend resolves a string', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.getPendingRotationRecovery).mockResolvedValue('word1 word2 word3')

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const phrase = await result.current.getPendingRotationRecovery()
    expect(phrase).toBe('word1 word2 word3')
    expect(tauri.getPendingRotationRecovery).toHaveBeenCalled()
  })

  it('getPendingRotationRecovery: returns null when backend resolves null', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.getPendingRotationRecovery).mockResolvedValue(null)

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const phrase = await result.current.getPendingRotationRecovery()
    expect(phrase).toBeNull()
  })

  it('getPendingRotationRecovery: returns null (no throw) when backend rejects', async () => {
    vi.mocked(tauri.getEncryptionMode).mockResolvedValue('password')
    vi.mocked(tauri.getPendingRotationRecovery).mockRejectedValue(new Error('backend error'))

    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.encryptionMode).toBe('password'))

    const phrase = await result.current.getPendingRotationRecovery()
    expect(phrase).toBeNull()
  })
})
