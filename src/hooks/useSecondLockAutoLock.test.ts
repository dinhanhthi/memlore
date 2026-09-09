import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSecondLockAutoLock } from './useSecondLockAutoLock'
import { useSecondLockStore } from '../stores/secondLockStore'

function seedSecondLockState({
  isEnabled = true,
  isSessionUnlocked = true,
  autoLockMinutes = 1,
}: {
  isEnabled?: boolean
  isSessionUnlocked?: boolean
  autoLockMinutes?: number
} = {}) {
  useSecondLockStore.setState({
    isEnabled,
    isSessionUnlocked,
    showExistence: false,
    autoLockMinutes,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  seedSecondLockState()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('useSecondLockAutoLock', () => {
  it('locks the second-lock session after the configured inactivity timeout', () => {
    renderHook(() => useSecondLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(59_999)
    })
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('resets the inactivity timer on user activity', () => {
    renderHook(() => useSecondLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(30_000)
      window.dispatchEvent(new MouseEvent('mousemove'))
      vi.advanceTimersByTime(30_001)
    })
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)

    act(() => {
      vi.advanceTimersByTime(29_999)
    })
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('does not start a timer when auto-lock is set to Never', () => {
    seedSecondLockState({ autoLockMinutes: 0 })
    renderHook(() => useSecondLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(10 * 60_000)
    })

    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)
  })

  it('does not start a timer when the feature is disabled', () => {
    seedSecondLockState({ isEnabled: false, isSessionUnlocked: true })
    renderHook(() => useSecondLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)
  })

  it('does not start a timer when the session is already locked', () => {
    seedSecondLockState({ isEnabled: true, isSessionUnlocked: false })
    renderHook(() => useSecondLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('cleans up timers and activity listeners on unmount', () => {
    const { unmount } = renderHook(() => useSecondLockAutoLock())

    unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' }))
      vi.advanceTimersByTime(60_000)
    })

    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)
  })
})
