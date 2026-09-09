import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useSecondLock } from './useSecondLock'
import { useSecondLockStore } from '../stores/secondLockStore'
import * as tauri from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  changeSecondLockPassword: vi.fn(),
  disableSecondLock: vi.fn(),
  getSetting: vi.fn(),
  secondLockStatus: vi.fn(),
  setEntryLocked: vi.fn(),
  setJournalLocked: vi.fn(),
  setSecondLockPassword: vi.fn(),
  setSetting: vi.fn(),
  verifySecondLockPassword: vi.fn(),
}))

const secondLockStatusMock = vi.mocked(tauri.secondLockStatus)
const getSettingMock = vi.mocked(tauri.getSetting)
const setSettingMock = vi.mocked(tauri.setSetting)
const setSecondLockPasswordMock = vi.mocked(tauri.setSecondLockPassword)
const changeSecondLockPasswordMock = vi.mocked(tauri.changeSecondLockPassword)
const verifySecondLockPasswordMock = vi.mocked(tauri.verifySecondLockPassword)
const disableSecondLockMock = vi.mocked(tauri.disableSecondLock)
const setEntryLockedMock = vi.mocked(tauri.setEntryLocked)
const setJournalLockedMock = vi.mocked(tauri.setJournalLocked)

function resetStore() {
  useSecondLockStore.setState({
    isEnabled: false,
    isSessionUnlocked: false,
    showExistence: false,
    autoLockMinutes: 5,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  resetStore()
  secondLockStatusMock.mockResolvedValue(false)
  getSettingMock.mockResolvedValue(null)
  setSettingMock.mockResolvedValue(undefined)
  setSecondLockPasswordMock.mockResolvedValue(undefined)
  changeSecondLockPasswordMock.mockResolvedValue(undefined)
  verifySecondLockPasswordMock.mockResolvedValue(false)
  disableSecondLockMock.mockResolvedValue(undefined)
  setEntryLockedMock.mockResolvedValue(undefined)
  setJournalLockedMock.mockResolvedValue(undefined)
})

describe('useSecondLock', () => {
  it('hydrates status and persisted preferences on mount', async () => {
    secondLockStatusMock.mockResolvedValue(true)
    getSettingMock.mockResolvedValueOnce('true').mockResolvedValueOnce('12')

    const { result } = renderHook(() => useSecondLock())

    await waitFor(() => expect(result.current.isEnabled).toBe(true))
    expect(result.current.showExistence).toBe(true)
    expect(result.current.autoLockMinutes).toBe(12)
    expect(secondLockStatusMock).toHaveBeenCalledTimes(1)
    expect(getSettingMock).toHaveBeenCalledWith('second_lock_show_existence')
    expect(getSettingMock).toHaveBeenCalledWith('second_lock_auto_lock_minutes')
  })

  it('can skip hydration when the real database is not ready yet', () => {
    renderHook(() => useSecondLock(false))

    expect(secondLockStatusMock).not.toHaveBeenCalled()
    expect(getSettingMock).not.toHaveBeenCalled()
  })

  it('setPassword enables and unlocks the current session after backend success', async () => {
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      await result.current.setPassword('secret')
    })

    expect(setSecondLockPasswordMock).toHaveBeenCalledWith('secret')
    expect(useSecondLockStore.getState().isEnabled).toBe(true)
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)
  })

  it('changePassword maps old and new passwords to the backend wrapper', async () => {
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      await result.current.changePassword('old', 'new')
    })

    expect(changeSecondLockPasswordMock).toHaveBeenCalledWith('old', 'new')
    expect(useSecondLockStore.getState().isEnabled).toBe(true)
  })

  it('unlock only unlocks the session when password verification returns true', async () => {
    verifySecondLockPasswordMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      expect(await result.current.unlock('wrong')).toBe(false)
    })
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)

    await act(async () => {
      expect(await result.current.unlock('right')).toBe(true)
    })
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)
    expect(verifySecondLockPasswordMock).toHaveBeenNthCalledWith(1, 'wrong')
    expect(verifySecondLockPasswordMock).toHaveBeenNthCalledWith(2, 'right')
  })

  it('verifyPassword delegates without mutating session state', async () => {
    verifySecondLockPasswordMock.mockResolvedValue(true)
    const { result } = renderHook(() => useSecondLock(false))

    await expect(result.current.verifyPassword('secret')).resolves.toBe(true)

    expect(verifySecondLockPasswordMock).toHaveBeenCalledWith('secret')
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('disable clears enabled and session state after backend success', async () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      await result.current.disable('secret')
    })

    expect(disableSecondLockMock).toHaveBeenCalledWith('secret')
    expect(useSecondLockStore.getState().isEnabled).toBe(false)
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('persists show-existence and auto-lock preferences before updating the store', async () => {
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      await result.current.setShowExistence(true)
      await result.current.setAutoLockMinutes(0)
    })

    expect(setSettingMock).toHaveBeenCalledWith('second_lock_show_existence', 'true')
    expect(setSettingMock).toHaveBeenCalledWith('second_lock_auto_lock_minutes', '0')
    expect(useSecondLockStore.getState().showExistence).toBe(true)
    expect(useSecondLockStore.getState().autoLockMinutes).toBe(0)
  })

  it('forwards entry and journal lock toggles to backend wrappers', async () => {
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      await result.current.setEntryLocked('entry-1', true)
      await result.current.setJournalLocked('journal-1', false)
    })

    expect(setEntryLockedMock).toHaveBeenCalledWith('entry-1', true)
    expect(setJournalLockedMock).toHaveBeenCalledWith('journal-1', false)
  })

  it('status refreshes the enabled state from backend', async () => {
    secondLockStatusMock.mockResolvedValue(true)
    const { result } = renderHook(() => useSecondLock(false))

    await act(async () => {
      expect(await result.current.status()).toBe(true)
    })

    expect(useSecondLockStore.getState().isEnabled).toBe(true)
  })
})
