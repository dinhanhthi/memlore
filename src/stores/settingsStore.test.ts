import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      isLocked: false,
      encryptionMode: null,
      isBiometricEnabled: false,
    })
  })

  it('has initial state', () => {
    const store = useSettingsStore.getState()
    expect(store.isLocked).toBe(false)
    expect(store.encryptionMode).toBe(null)
    expect(store.isBiometricEnabled).toBe(false)
  })

  it('updates isLocked state', () => {
    useSettingsStore.getState().setLocked(false)
    expect(useSettingsStore.getState().isLocked).toBe(false)

    useSettingsStore.getState().setLocked(true)
    expect(useSettingsStore.getState().isLocked).toBe(true)
  })

  it('updates isBiometricEnabled state', () => {
    useSettingsStore.getState().setBiometricEnabled(true)
    expect(useSettingsStore.getState().isBiometricEnabled).toBe(true)

    useSettingsStore.getState().setBiometricEnabled(false)
    expect(useSettingsStore.getState().isBiometricEnabled).toBe(false)
  })

  it('updates multiple states independently', () => {
    useSettingsStore.getState().setLocked(false)
    useSettingsStore.getState().setBiometricEnabled(true)

    const store = useSettingsStore.getState()
    expect(store.isLocked).toBe(false)
    expect(store.isBiometricEnabled).toBe(true)
  })

  // ─── Chunk 2.5: encryptionMode ───────────────────────────────────────────

  it('encryptionMode starts as null (not yet probed)', () => {
    expect(useSettingsStore.getState().encryptionMode).toBe(null)
  })

  it('setEncryptionMode updates encryptionMode to password', () => {
    useSettingsStore.getState().setEncryptionMode('password')
    expect(useSettingsStore.getState().encryptionMode).toBe('password')
  })

  it('setEncryptionMode updates encryptionMode to unset', () => {
    useSettingsStore.getState().setEncryptionMode('password')
    useSettingsStore.getState().setEncryptionMode('unset')
    expect(useSettingsStore.getState().encryptionMode).toBe('unset')
  })

  it('setEncryptionMode(null) resets to unprobed', () => {
    useSettingsStore.getState().setEncryptionMode('password')
    useSettingsStore.getState().setEncryptionMode(null)
    expect(useSettingsStore.getState().encryptionMode).toBe(null)
  })
})
