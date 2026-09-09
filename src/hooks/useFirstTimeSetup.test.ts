import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock the tauri module before importing the hook
vi.mock('../lib/tauri', () => ({
  beginFirstTimeSetup: vi.fn(),
  confirmFirstTimeSetup: vi.fn(),
  cancelFirstTimeSetup: vi.fn(),
  getPendingFirstTimeSetup: vi.fn(),
}))

import {
  beginFirstTimeSetup,
  confirmFirstTimeSetup,
  cancelFirstTimeSetup,
  getPendingFirstTimeSetup,
} from '../lib/tauri'
import { useFirstTimeSetup } from './useFirstTimeSetup'

const mockedBegin = vi.mocked(beginFirstTimeSetup)
const mockedConfirm = vi.mocked(confirmFirstTimeSetup)
const mockedCancel = vi.mocked(cancelFirstTimeSetup)
const mockedGetPending = vi.mocked(getPendingFirstTimeSetup)

const MOCK_HANDLE = {
  setup_id: 'uuid-123',
  mnemonic: Array.from({ length: 24 }, (_, i) => `word${i + 1}`),
  challenge_indices: [3, 11, 17, 22],
}

beforeEach(() => {
  vi.resetAllMocks()
  // Default: no pending setup
  mockedGetPending.mockResolvedValue(null)
})

describe('useFirstTimeSetup', () => {
  it('initial state is idle', async () => {
    const { result } = renderHook(() => useFirstTimeSetup())
    // Wait for the resume effect to settle
    await act(async () => {})
    expect(result.current.stage.kind).toBe('idle')
  })

  it('beginSetup transitions idle → submitting → mnemonic_revealed and stores the handle', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })

    expect(mockedBegin).toHaveBeenCalledWith('secret123', 'MacBook Pro')
    expect(result.current.stage.kind).toBe('mnemonic_revealed')
    if (result.current.stage.kind === 'mnemonic_revealed') {
      expect(result.current.stage.setupId).toBe('uuid-123')
      expect(result.current.stage.mnemonic).toEqual(MOCK_HANDLE.mnemonic)
      expect(result.current.stage.challengeIndices).toEqual(MOCK_HANDLE.challenge_indices)
    }
  })

  it('proceedToConfirm transitions mnemonic_revealed → confirm_pending', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })
    expect(result.current.stage.kind).toBe('mnemonic_revealed')

    act(() => {
      result.current.proceedToConfirm()
    })
    expect(result.current.stage.kind).toBe('confirm_pending')
    if (result.current.stage.kind === 'confirm_pending') {
      expect(result.current.stage.setupId).toBe('uuid-123')
      expect(result.current.stage.mnemonic).toEqual(MOCK_HANDLE.mnemonic)
      expect(result.current.stage.challengeIndices).toEqual(MOCK_HANDLE.challenge_indices)
    }
  })

  it('cancelSetup calls cancel command and returns to idle', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    mockedCancel.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })

    await act(async () => {
      await result.current.cancelSetup()
    })

    expect(mockedCancel).toHaveBeenCalledWith('uuid-123')
    expect(result.current.stage.kind).toBe('idle')
  })

  it('submitConfirmation with correct args transitions to done', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    mockedConfirm.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })
    act(() => {
      result.current.proceedToConfirm()
    })

    await act(async () => {
      await result.current.submitConfirmation(['word4', 'word12', 'word18', 'word23'], 'secret123')
    })

    expect(mockedConfirm).toHaveBeenCalledWith(
      'uuid-123',
      ['word4', 'word12', 'word18', 'word23'],
      'secret123',
      undefined,
      undefined,
    )
    expect(result.current.stage.kind).toBe('done')
  })

  it('submitConfirmation forwards the picked unlock method', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    mockedConfirm.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFirstTimeSetup('session-9'))
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })
    act(() => {
      result.current.proceedToConfirm()
    })

    await act(async () => {
      await result.current.submitConfirmation(
        ['word4', 'word12', 'word18', 'word23'],
        'secret123',
        'both',
      )
    })

    expect(mockedConfirm).toHaveBeenCalledWith(
      'uuid-123',
      ['word4', 'word12', 'word18', 'word23'],
      'secret123',
      'session-9',
      'both',
    )
  })

  it('failed submitConfirmation transitions to confirm_pending with error and re-throws', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    mockedConfirm.mockRejectedValue(new Error('Wrong answers'))
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })
    act(() => {
      result.current.proceedToConfirm()
    })

    // submitConfirmation now re-throws so the screen can clear the password field.
    await act(async () => {
      await expect(
        result.current.submitConfirmation(['bad', 'words', 'here', 'yep'], 'secret123'),
      ).rejects.toThrow('Wrong answers')
    })

    // State stays in confirm_pending (retry-able) with error message set.
    expect(result.current.stage.kind).toBe('confirm_pending')
    if (result.current.stage.kind === 'confirm_pending') {
      expect(result.current.stage.error).toBe('Wrong answers')
    }
  })

  it('failed submitConfirmation extracts message from plain string rejection (Tauri style)', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    // Tauri rejects with plain strings, not Error objects.
    mockedConfirm.mockRejectedValue('incorrect password')
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })
    act(() => {
      result.current.proceedToConfirm()
    })

    await act(async () => {
      await expect(
        result.current.submitConfirmation(['bad', 'words', 'here', 'yep'], 'wrong-pass'),
      ).rejects.toThrow('incorrect password')
    })

    expect(result.current.stage.kind).toBe('confirm_pending')
    if (result.current.stage.kind === 'confirm_pending') {
      expect(result.current.stage.error).toBe('incorrect password')
    }
  })

  it('resume() on mount with pending row sets state to mnemonic_revealed', async () => {
    mockedGetPending.mockResolvedValue(MOCK_HANDLE)
    const { result } = renderHook(() => useFirstTimeSetup())

    await act(async () => {})

    expect(mockedGetPending).toHaveBeenCalled()
    expect(result.current.stage.kind).toBe('mnemonic_revealed')
    if (result.current.stage.kind === 'mnemonic_revealed') {
      expect(result.current.stage.setupId).toBe('uuid-123')
      expect(result.current.stage.mnemonic).toEqual(MOCK_HANDLE.mnemonic)
      expect(result.current.stage.challengeIndices).toEqual(MOCK_HANDLE.challenge_indices)
    }
  })

  it('resume() on mount with no pending row leaves state at idle', async () => {
    mockedGetPending.mockResolvedValue(null)
    const { result } = renderHook(() => useFirstTimeSetup())

    await act(async () => {})

    expect(result.current.stage.kind).toBe('idle')
  })

  it('cancelSetup from confirm_pending also calls cancel command and returns to idle', async () => {
    mockedBegin.mockResolvedValue(MOCK_HANDLE)
    mockedCancel.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFirstTimeSetup())
    await act(async () => {})

    await act(async () => {
      await result.current.beginSetup('secret123', 'MacBook Pro')
    })
    act(() => {
      result.current.proceedToConfirm()
    })
    expect(result.current.stage.kind).toBe('confirm_pending')

    await act(async () => {
      await result.current.cancelSetup()
    })

    expect(mockedCancel).toHaveBeenCalledWith('uuid-123')
    expect(result.current.stage.kind).toBe('idle')
  })
})
