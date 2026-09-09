import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useVersionRetention } from './useVersionRetention'

vi.mock('../lib/tauri', () => ({
  getVersionRetentionDays: vi.fn(),
  setVersionRetentionDays: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const mockGetVersionRetentionDays = vi.mocked(tauri.getVersionRetentionDays)
const mockSetVersionRetentionDays = vi.mocked(tauri.setVersionRetentionDays)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useVersionRetention', () => {
  it('starts with days=null and isLoading=true, then hydrates from the backend', async () => {
    mockGetVersionRetentionDays.mockResolvedValue(7)
    const { result } = renderHook(() => useVersionRetention())

    expect(result.current.days).toBeNull()
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.days).toBe(7)
    expect(mockGetVersionRetentionDays).toHaveBeenCalledWith()
  })

  it('surfaces an error message when the initial fetch rejects', async () => {
    mockGetVersionRetentionDays.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useVersionRetention())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.error).toBe('boom')
    expect(result.current.days).toBeNull()
  })

  it('setDays persists via setVersionRetentionDays and updates the live value', async () => {
    mockGetVersionRetentionDays.mockResolvedValue(7)
    mockSetVersionRetentionDays.mockResolvedValue(undefined)
    const { result } = renderHook(() => useVersionRetention())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.setDays(15)
    })

    expect(mockSetVersionRetentionDays).toHaveBeenCalledWith(15)
    expect(result.current.days).toBe(15)
  })
})
