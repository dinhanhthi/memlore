import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLockAction } from './useLockAction'
import { useSettingsStore } from '../stores/settingsStore'
import { makeDefaultTab, useTabStore, type Tab } from '../stores/tabStore'
import * as tauri from '../lib/tauri'

// Use importActual so future tauri exports added to the hook don't
// silently become `undefined` here.
vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return { ...actual, lockEncryption: vi.fn() }
})

const lockEncryptionMock = vi.mocked(tauri.lockEncryption)

function seedSettings(partial: Partial<ReturnType<typeof useSettingsStore.getState>>) {
  useSettingsStore.setState({
    isLocked: false,
    encryptionMode: null,
    isBiometricEnabled: false,
    ...partial,
  })
}

function seedTabs(tabs: Tab[], activeTabId: string) {
  useTabStore.setState({ tabs, activeTabId })
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    ...makeDefaultTab(),
    id: 'tab-1',
    dirty: false,
    ...overrides,
  }
}

beforeEach(() => {
  lockEncryptionMock.mockReset()
  lockEncryptionMock.mockResolvedValue(undefined)
  seedSettings({})
  seedTabs([makeTab({ id: 'tab-1' })], 'tab-1')
})

describe('useLockAction.canLock', () => {
  it('is true only when encryptionMode === password', () => {
    seedSettings({ encryptionMode: 'password' })
    const { result } = renderHook(() => useLockAction())
    expect(result.current.canLock).toBe(true)
  })

  it('is false when encryptionMode is null (not yet probed)', () => {
    seedSettings({ encryptionMode: null })
    const { result } = renderHook(() => useLockAction())
    expect(result.current.canLock).toBe(false)
  })

  it('is false when encryptionMode is unset (fresh install)', () => {
    seedSettings({ encryptionMode: 'unset' })
    const { result } = renderHook(() => useLockAction())
    expect(result.current.canLock).toBe(false)
  })
})

describe('useLockAction.lockBlockedReason', () => {
  it('is null when encryption is password mode and no tab is dirty', () => {
    seedSettings({ encryptionMode: 'password' })
    seedTabs([makeTab({ dirty: false })], 'tab-1')
    const { result } = renderHook(() => useLockAction())
    expect(result.current.lockBlockedReason).toBeNull()
  })

  it('is "no-password" when encryption is not password mode (overrides dirty)', () => {
    seedSettings({ encryptionMode: null })
    seedTabs([makeTab({ dirty: true })], 'tab-1')
    const { result } = renderHook(() => useLockAction())
    expect(result.current.lockBlockedReason).toBe('no-password')
  })

  it('is "saving" when active tab is dirty', () => {
    seedSettings({ encryptionMode: 'password' })
    seedTabs([makeTab({ id: 'tab-1', dirty: true })], 'tab-1')
    const { result } = renderHook(() => useLockAction())
    expect(result.current.lockBlockedReason).toBe('saving')
  })

  it('ignores dirty state of non-active tabs', () => {
    seedSettings({ encryptionMode: 'password' })
    seedTabs(
      [makeTab({ id: 'tab-1', dirty: false }), makeTab({ id: 'tab-2', dirty: true })],
      'tab-1',
    )
    const { result } = renderHook(() => useLockAction())
    expect(result.current.lockBlockedReason).toBeNull()
  })
})

describe('useLockAction.lock', () => {
  it('calls tauri.lockEncryption exactly once', async () => {
    seedSettings({ encryptionMode: 'password' })
    const { result } = renderHook(() => useLockAction())
    await act(async () => {
      await result.current.lock()
    })
    expect(lockEncryptionMock).toHaveBeenCalledTimes(1)
  })

  it('flips isLocked to true on success', async () => {
    seedSettings({ encryptionMode: 'password', isLocked: false })
    const { result } = renderHook(() => useLockAction())
    await act(async () => {
      await result.current.lock()
    })
    expect(useSettingsStore.getState().isLocked).toBe(true)
  })

  it('still flips isLocked to true when backend lock fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    lockEncryptionMock.mockRejectedValueOnce(new Error('backend exploded'))
    seedSettings({ encryptionMode: 'password', isLocked: false })
    const { result } = renderHook(() => useLockAction())
    await act(async () => {
      await result.current.lock()
    })
    expect(useSettingsStore.getState().isLocked).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
