import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useRestoredScroll } from './useRestoredScroll'
import { clearTabScroll, getTabScroll, setTabScroll } from '../lib/tabScrollPositions'

function makeScroller(
  scrollTop = 0,
  opts?: { clientHeight?: number; scrollHeight?: number; display?: string },
): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: opts?.clientHeight ?? 400,
  })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: opts?.scrollHeight ?? 2000,
  })
  if (opts?.display) el.style.display = opts.display
  el.scrollTop = scrollTop
  return el
}

let roCallback: ResizeObserverCallback | null = null

beforeEach(() => {
  clearTabScroll()
  roCallback = null
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useRestoredScroll', () => {
  it('saves scrollTop for the current key on unmount', () => {
    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(180)

    const { unmount } = renderHook(() => useRestoredScroll(ref, 'tab-1:entries'))
    unmount()

    expect(getTabScroll('tab-1:entries')).toBe(180)
  })

  it('restores a saved scrollTop on remount', () => {
    setTabScroll('tab-1:entries', 240)
    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(0)

    const { result } = renderHook(() => useRestoredScroll(ref, 'tab-1:entries'))

    expect(ref.current?.scrollTop).toBe(240)
    expect(result.current.restored).toBe(true)
  })

  it('isolates positions when the key changes', () => {
    setTabScroll('tab-1:entries', 100)
    setTabScroll('tab-1:calendar', 200)

    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(0)

    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useRestoredScroll(ref, key),
      { initialProps: { key: 'tab-1:entries' as string | null } },
    )

    expect(ref.current?.scrollTop).toBe(100)
    expect(result.current.restored).toBe(true)

    ref.current.scrollTop = 140
    rerender({ key: 'tab-1:calendar' })

    expect(getTabScroll('tab-1:entries')).toBe(140)
    expect(ref.current?.scrollTop).toBe(200)
    expect(result.current.restored).toBe(true)
  })

  it('waits until ready becomes true before restoring', () => {
    setTabScroll('tab-1:entries', 90)
    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(0)

    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useRestoredScroll(ref, 'tab-1:entries', { ready }),
      { initialProps: { ready: false } },
    )

    expect(ref.current?.scrollTop).toBe(0)
    expect(result.current.restored).toBe(false)

    rerender({ ready: true })

    expect(ref.current?.scrollTop).toBe(90)
    expect(result.current.restored).toBe(true)
  })

  it('reports not restored when no saved value exists', () => {
    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(0)

    const { result } = renderHook(() => useRestoredScroll(ref, 'tab-1:entries'))

    expect(ref.current?.scrollTop).toBe(0)
    expect(result.current.restored).toBe(false)
  })

  it('does nothing when key is null', () => {
    setTabScroll('tab-1:entries', 50)
    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(12)

    const { result, unmount } = renderHook(() => useRestoredScroll(ref, null))

    expect(ref.current?.scrollTop).toBe(12)
    expect(result.current.restored).toBe(false)

    ref.current.scrollTop = 77
    unmount()
    expect(getTabScroll('tab-1:entries')).toBe(50)
  })

  it('saves scrollTop on scroll, rAF-throttled', () => {
    vi.useFakeTimers()
    const ref = createRef<HTMLElement | null>()
    ref.current = makeScroller(0)

    renderHook(() => useRestoredScroll(ref, 'tab-1:entries'))

    ref.current.scrollTop = 333
    ref.current.dispatchEvent(new Event('scroll'))
    expect(getTabScroll('tab-1:entries')).toBeUndefined()

    vi.runAllTimers()
    expect(getTabScroll('tab-1:entries')).toBe(333)
    vi.useRealTimers()
  })

  it('does not apply a saved position while the port is too short, then restores on resize', () => {
    setTabScroll('tab-1:onthisday', 400)
    const ref = createRef<HTMLElement | null>()
    const el = makeScroller(0, { clientHeight: 400, scrollHeight: 400 })
    ref.current = el

    const { result } = renderHook(() => useRestoredScroll(ref, 'tab-1:onthisday'))

    expect(el.scrollTop).toBe(0)
    expect(result.current.restored).toBe(false)

    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    act(() => {
      roCallback?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
    })

    expect(el.scrollTop).toBe(400)
    expect(result.current.restored).toBe(true)
  })

  it('does not write 0 into the map when a hidden port fires scroll', () => {
    vi.useFakeTimers()
    setTabScroll('tab-1:settings:ai:chat', 400)
    const ref = createRef<HTMLElement | null>()
    const el = makeScroller(400, { display: 'none' })
    ref.current = el

    renderHook(() => useRestoredScroll(ref, 'tab-1:settings:ai:chat'))

    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
    vi.runAllTimers()
    vi.useRealTimers()

    expect(getTabScroll('tab-1:settings:ai:chat')).toBe(400)
  })
})
