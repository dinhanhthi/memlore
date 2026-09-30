import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCountUp } from './useCountUp'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

vi.mock('./usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: vi.fn(() => false),
}))

const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let now = 0

const requestAnimationFrameMock = vi.fn((cb: FrameRequestCallback): number => {
  const id = nextFrameId++
  frames.set(id, cb)
  return id
})

const cancelAnimationFrameMock = vi.fn((id: number) => {
  frames.delete(id)
})

function installClock() {
  frames.clear()
  nextFrameId = 1
  now = 0
  requestAnimationFrameMock.mockClear()
  cancelAnimationFrameMock.mockClear()
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock)
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
}

/** Move the fake clock and run every frame queued at the new timestamp. */
function advance(ms: number) {
  act(() => {
    now += ms
    vi.advanceTimersByTime(ms)
    const pending = [...frames.entries()]
    frames.clear()
    for (const [, cb] of pending) cb(now)
  })
}

beforeEach(() => {
  installClock()
  vi.mocked(usePrefersReducedMotion).mockReturnValue(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useCountUp', () => {
  it('reaches target after the duration', () => {
    const { result } = renderHook(() => useCountUp(100))
    expect(result.current).toBe(0)

    // outCubic(0.5) = 1 - (1 - 0.5)^3 = 0.875 → 88
    advance(450)
    expect(result.current).toBe(88)

    advance(450)
    expect(result.current).toBe(100)
  })

  it('returns target on the first render when reduced motion is preferred', () => {
    vi.mocked(usePrefersReducedMotion).mockReturnValue(true)
    const seen: number[] = []
    const { result } = renderHook(() => {
      const value = useCountUp(42)
      seen.push(value)
      return value
    })

    expect(seen[0]).toBe(42)
    expect(result.current).toBe(42)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()
  })

  it('jumps to a new target after the first animation without ramping from 0', () => {
    const { result, rerender } = renderHook(({ target }: { target: number }) => useCountUp(target), {
      initialProps: { target: 100 },
    })

    advance(900)
    expect(result.current).toBe(100)

    const framesScheduled = requestAnimationFrameMock.mock.calls.length
    rerender({ target: 40 })
    expect(result.current).toBe(40)

    advance(450)
    expect(result.current).toBe(40)
    expect(requestAnimationFrameMock.mock.calls.length).toBe(framesScheduled)
  })

  it('cancels the pending animation frame on unmount', () => {
    const { unmount } = renderHook(() => useCountUp(80))
    expect(requestAnimationFrameMock).toHaveBeenCalledOnce()
    const frameId = requestAnimationFrameMock.mock.results[0]?.value as number

    unmount()

    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(frameId)
  })
})
