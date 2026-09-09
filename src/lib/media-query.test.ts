import { describe, it, expect, vi, beforeEach } from 'vitest'
import { osPrefersDark, osPrefersReducedMotion, subscribeMediaQuery } from './media-query'

interface FakeMQL {
  matches: boolean
  addEventListener?: (type: string, l: (e: MediaQueryListEvent) => void) => void
  removeEventListener?: (type: string, l: (e: MediaQueryListEvent) => void) => void
  addListener?: (l: (e: MediaQueryListEvent) => void) => void
  removeListener?: (l: (e: MediaQueryListEvent) => void) => void
}

function mockMatchMedia(factory: (query: string) => FakeMQL): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation(factory),
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('osPrefersDark', () => {
  it('returns true when matchMedia reports dark', () => {
    mockMatchMedia(() => ({ matches: true }))
    expect(osPrefersDark()).toBe(true)
  })

  it('returns false when matchMedia reports light', () => {
    mockMatchMedia(() => ({ matches: false }))
    expect(osPrefersDark()).toBe(false)
  })
})

describe('osPrefersReducedMotion', () => {
  it('reflects matchMedia matches value', () => {
    mockMatchMedia(() => ({ matches: true }))
    expect(osPrefersReducedMotion()).toBe(true)
    mockMatchMedia(() => ({ matches: false }))
    expect(osPrefersReducedMotion()).toBe(false)
  })
})

describe('subscribeMediaQuery', () => {
  it('uses addEventListener when available and forwards matches', () => {
    const listenerRef: { current: ((e: MediaQueryListEvent) => void) | null } = { current: null }
    const addEventListener = vi.fn((_: string, l: (e: MediaQueryListEvent) => void) => {
      listenerRef.current = l
    })
    const removeEventListener = vi.fn()
    mockMatchMedia(() => ({ matches: false, addEventListener, removeEventListener }))

    const handler = vi.fn()
    const unsubscribe = subscribeMediaQuery('(prefers-color-scheme: dark)', handler)

    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    listenerRef.current?.({ matches: true } as MediaQueryListEvent)
    expect(handler).toHaveBeenCalledWith(true)

    unsubscribe()
    expect(removeEventListener).toHaveBeenCalled()
  })

  it('falls back to addListener when addEventListener is missing (Safari < 14)', () => {
    const listenerRef: { current: ((e: MediaQueryListEvent) => void) | null } = { current: null }
    const addListener = vi.fn((l: (e: MediaQueryListEvent) => void) => {
      listenerRef.current = l
    })
    const removeListener = vi.fn()
    // Note: no addEventListener on this fake MQL — simulates legacy WebKit
    mockMatchMedia(() => ({ matches: false, addListener, removeListener }))

    const handler = vi.fn()
    const unsubscribe = subscribeMediaQuery('(prefers-reduced-motion: reduce)', handler)

    expect(addListener).toHaveBeenCalledOnce()
    listenerRef.current?.({ matches: true } as MediaQueryListEvent)
    expect(handler).toHaveBeenCalledWith(true)

    unsubscribe()
    expect(removeListener).toHaveBeenCalled()
  })

  it('returns a no-op unsubscribe when matchMedia is unavailable', () => {
    const original = window.matchMedia
    // @ts-expect-error simulating SSR / non-DOM env
    delete window.matchMedia
    const handler = vi.fn()
    const unsubscribe = subscribeMediaQuery('(prefers-color-scheme: dark)', handler)
    expect(() => unsubscribe()).not.toThrow()
    window.matchMedia = original
  })
})
