import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  icloudAvailability: vi.fn(),
}))

import { icloudAvailability } from '../lib/tauri'
import { useIcloudAvailability } from './useIcloudAvailability'

const mockedProbe = vi.mocked(icloudAvailability)

describe('useIcloudAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts in the loading state with available=false', () => {
    mockedProbe.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useIcloudAvailability())

    expect(result.current.loading).toBe(true)
    expect(result.current.available).toBe(false)
  })

  it('reports available=true when the probe resolves available', async () => {
    mockedProbe.mockResolvedValue({ available: true, path: '/icloud' })
    const { result } = renderHook(() => useIcloudAvailability())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.available).toBe(true)
    expect(mockedProbe).toHaveBeenCalled()
  })

  it('reports available=false when the probe resolves unavailable', async () => {
    mockedProbe.mockResolvedValue({ available: false, path: '' })
    const { result } = renderHook(() => useIcloudAvailability())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.available).toBe(false)
  })

  it('degrades to available=false when the probe rejects, and still settles loading', async () => {
    mockedProbe.mockRejectedValue(new Error('platform error'))
    const { result } = renderHook(() => useIcloudAvailability())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.available).toBe(false)
  })
})
