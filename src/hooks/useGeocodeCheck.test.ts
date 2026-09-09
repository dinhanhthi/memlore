import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/tauri', () => ({
  geocodeCheck: vi.fn(),
}))

import { geocodeCheck } from '../lib/tauri'
import { useGeocodeCheck } from './useGeocodeCheck'

const mockedCheck = vi.mocked(geocodeCheck)

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useGeocodeCheck', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useGeocodeCheck())
    expect(result.current.status).toBe('idle')
    expect(result.current.errorCode).toBeNull()
  })

  it('transitions idle → checking → success on resolved probe', async () => {
    mockedCheck.mockResolvedValue(undefined)
    const { result } = renderHook(() => useGeocodeCheck())

    await act(async () => {
      await result.current.check('nominatim')
    })

    expect(mockedCheck).toHaveBeenCalledWith('nominatim', undefined)
    expect(result.current.status).toBe('success')
    expect(result.current.errorCode).toBeNull()
  })

  it('transitions to error with normalized code on known failure', async () => {
    mockedCheck.mockRejectedValue('invalid_key')
    const { result } = renderHook(() => useGeocodeCheck())

    await act(async () => {
      await result.current.check('mapbox', 'pk.bad')
    })

    expect(result.current.status).toBe('error')
    expect(result.current.errorCode).toBe('invalid_key')
  })

  it('normalizes unknown error strings to "unknown"', async () => {
    mockedCheck.mockRejectedValue('something-weird')
    const { result } = renderHook(() => useGeocodeCheck())

    await act(async () => {
      await result.current.check('mapbox', 'pk.bad')
    })

    expect(result.current.status).toBe('error')
    expect(result.current.errorCode).toBe('unknown')
  })

  it('passes API key through to the backend call', async () => {
    mockedCheck.mockResolvedValue(undefined)
    const { result } = renderHook(() => useGeocodeCheck())

    await act(async () => {
      await result.current.check('google', 'AIza-key')
    })

    expect(mockedCheck).toHaveBeenCalledWith('google', 'AIza-key')
  })

  it('reset() clears state immediately', async () => {
    mockedCheck.mockRejectedValue('invalid_key')
    const { result } = renderHook(() => useGeocodeCheck())

    await act(async () => {
      await result.current.check('mapbox', 'pk.bad')
    })
    expect(result.current.status).toBe('error')

    act(() => result.current.reset())
    expect(result.current.status).toBe('idle')
    expect(result.current.errorCode).toBeNull()
  })

  it('auto-resets to idle after autoResetMs', async () => {
    vi.useFakeTimers()
    mockedCheck.mockResolvedValue(undefined)
    const { result } = renderHook(() => useGeocodeCheck(1000))

    await act(async () => {
      await result.current.check('nominatim')
    })
    expect(result.current.status).toBe('success')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.status).toBe('idle')
  })

  it('discards results of a superseded in-flight check', async () => {
    let resolveFirst: () => void = () => {}
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    mockedCheck.mockReturnValueOnce(firstPromise).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useGeocodeCheck())

    // Fire the first call without awaiting it
    let firstCall: Promise<void> | undefined
    act(() => {
      firstCall = result.current.check('mapbox', 'pk.first')
    })
    expect(result.current.status).toBe('checking')

    // Fire the second call (supersedes the first)
    await act(async () => {
      await result.current.check('nominatim')
    })
    expect(result.current.status).toBe('success')

    // Now let the first call resolve — its result must be discarded
    await act(async () => {
      resolveFirst()
      await firstCall
    })

    // Wait for any pending state flushes; status must remain success.
    await waitFor(() => expect(result.current.status).toBe('success'))
  })
})
