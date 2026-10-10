import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useWebAutoLock } from './useWebAutoLock'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const mockGetSetting = vi.mocked(tauri.getSetting)
const mockSetSetting = vi.mocked(tauri.setSetting)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useWebAutoLock', () => {
  it('hydrates the stored minutes', async () => {
    mockGetSetting.mockResolvedValue('5')
    const { result } = renderHook(() => useWebAutoLock())

    await waitFor(() => expect(result.current.minutes).toBe('5'))
    expect(mockGetSetting).toHaveBeenCalledWith('web_auto_lock_minutes')
  })

  it.each([
    ['unset', () => mockGetSetting.mockResolvedValue(null)],
    ['unknown', () => mockGetSetting.mockResolvedValue('0')],
    ['unreadable', () => mockGetSetting.mockRejectedValue(new Error('locked'))],
  ])('shows the 15 min default when %s', async (_name, arrange) => {
    arrange()
    const { result } = renderHook(() => useWebAutoLock())

    await waitFor(() => expect(mockGetSetting).toHaveBeenCalled())
    expect(result.current.minutes).toBe('15')
  })

  it('setMinutes persists and updates the live value', async () => {
    mockGetSetting.mockResolvedValue(null)
    mockSetSetting.mockResolvedValue(undefined)
    const { result } = renderHook(() => useWebAutoLock())

    await act(async () => {
      await result.current.setMinutes('30')
    })

    expect(mockSetSetting).toHaveBeenCalledWith('web_auto_lock_minutes', '30')
    expect(result.current.minutes).toBe('30')
  })

  it('keeps the previous value when the write fails', async () => {
    mockGetSetting.mockResolvedValue('5')
    mockSetSetting.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useWebAutoLock())
    await waitFor(() => expect(result.current.minutes).toBe('5'))

    await act(async () => {
      await expect(result.current.setMinutes('1')).rejects.toThrow('boom')
    })

    expect(result.current.minutes).toBe('5')
  })
})
