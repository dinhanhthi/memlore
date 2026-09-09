import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// Mock the tauri module before importing the hook — never hit the real backend.
vi.mock('../lib/tauri', () => ({
  isBiometricAvailable: vi.fn(),
}))

import { isBiometricAvailable } from '../lib/tauri'
import { useBiometricAvailability } from './useBiometricAvailability'

const mockedProbe = vi.mocked(isBiometricAvailable)

describe('useBiometricAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts in the loading state with available=false', () => {
    mockedProbe.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useBiometricAvailability())

    expect(result.current.loading).toBe(true)
    expect(result.current.available).toBe(false)
  })

  it('reports available=true when the probe resolves true', async () => {
    mockedProbe.mockResolvedValue(true)
    const { result } = renderHook(() => useBiometricAvailability())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.available).toBe(true)
    expect(mockedProbe).toHaveBeenCalled()
  })

  it('reports available=false when the probe resolves false', async () => {
    mockedProbe.mockResolvedValue(false)
    const { result } = renderHook(() => useBiometricAvailability())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.available).toBe(false)
  })

  it('degrades to available=false when the probe rejects, and still settles loading', async () => {
    mockedProbe.mockRejectedValue(new Error('platform error'))
    const { result } = renderHook(() => useBiometricAvailability())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.available).toBe(false)
  })
})
