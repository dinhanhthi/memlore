import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useInvisibleLockAutoLock } from './useInvisibleLockAutoLock'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

function seedInvisibleLockState({
  activeVaultId = 'vault-a' as string | null,
  autoLockMinutes = 1,
}: {
  activeVaultId?: string | null
  autoLockMinutes?: number
} = {}) {
  useInvisibleLockStore.setState({
    activeVaultId,
    autoLockMinutes,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  seedInvisibleLockState()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('useInvisibleLockAutoLock', () => {
  it('locks the invisible-lock session after the configured inactivity timeout', () => {
    renderHook(() => useInvisibleLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(59_999)
    })
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
  })

  it('resets the inactivity timer on user activity', () => {
    renderHook(() => useInvisibleLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(30_000)
      window.dispatchEvent(new MouseEvent('mousemove'))
      vi.advanceTimersByTime(30_001)
    })
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')

    act(() => {
      vi.advanceTimersByTime(29_999)
    })
    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
  })

  it('does not start a timer when auto-lock is set to Never', () => {
    seedInvisibleLockState({ autoLockMinutes: 0 })
    renderHook(() => useInvisibleLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(10 * 60_000)
    })

    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')
  })

  it('does not start a timer when the session is already locked', () => {
    seedInvisibleLockState({ activeVaultId: null })
    renderHook(() => useInvisibleLockAutoLock())

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
  })

  it('cleans up timers and activity listeners on unmount', () => {
    const { unmount } = renderHook(() => useInvisibleLockAutoLock())

    unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A' }))
      vi.advanceTimersByTime(60_000)
    })

    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')
  })
})
