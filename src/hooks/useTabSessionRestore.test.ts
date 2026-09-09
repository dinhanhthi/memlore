import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDefaultTab, useTabStore } from '../stores/tabStore'
import type { Tab } from '../stores/tabStore'
import {
  flushTabSession,
  useFlushTabSessionOnClose,
  useTabSessionHydrated,
} from './useTabSessionRestore'

const { closeHandlers, unlistenClose } = vi.hoisted(() => ({
  closeHandlers: [] as Array<() => void>,
  unlistenClose: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (handler: () => void) => {
      closeHandlers.push(handler)
      return Promise.resolve(() => {
        unlistenClose()
      })
    },
  }),
}))

function seedStore(tabs: Tab[], activeTabId: string) {
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

function readStoredSession(): { tabs: { id: string }[]; activeTabId: string } | null {
  const stored = localStorage.getItem('memlore-tabs')
  if (!stored) return null
  const parsed = JSON.parse(stored) as {
    state: { tabs: { id: string }[]; activeTabId: string }
  }
  return parsed.state
}

beforeEach(() => {
  closeHandlers.length = 0
  unlistenClose.mockClear()
  seedStore([makeTab({ id: 'tab-1' })], 'tab-1')
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })
})

describe('useTabSessionHydrated', () => {
  it('returns persist.hasHydrated() as the initial value', () => {
    const { result } = renderHook(() => useTabSessionHydrated())
    expect(result.current).toBe(useTabStore.persist.hasHydrated())
  })

  it('subscribes to onFinishHydration and unsubscribes on unmount', () => {
    const unsub = vi.fn()
    const spy = vi.spyOn(useTabStore.persist, 'onFinishHydration').mockReturnValue(unsub)

    const { unmount } = renderHook(() => useTabSessionHydrated())
    expect(spy).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('flips to true when onFinishHydration fires after a false start', () => {
    vi.spyOn(useTabStore.persist, 'hasHydrated').mockReturnValue(false)
    let finish: (() => void) | undefined
    vi.spyOn(useTabStore.persist, 'onFinishHydration').mockImplementation((cb) => {
      finish = () => cb(useTabStore.getState())
      return vi.fn()
    })

    const { result } = renderHook(() => useTabSessionHydrated())
    expect(result.current).toBe(false)

    act(() => {
      finish?.()
    })
    expect(result.current).toBe(true)
  })

  it('is true after rehydrate of corrupt memlore-tabs JSON', async () => {
    localStorage.setItem('memlore-tabs', '{not json')
    await useTabStore.persist.rehydrate()
    const { result } = renderHook(() => useTabSessionHydrated())
    expect(useTabStore.persist.hasHydrated()).toBe(true)
    expect(result.current).toBe(true)
  })

  it('is true after rehydrate when persisted tabs is not an array', async () => {
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: null, activeTabId: 'x' }, version: 0 }),
    )
    await useTabStore.persist.rehydrate()
    const { result } = renderHook(() => useTabSessionHydrated())
    expect(useTabStore.persist.hasHydrated()).toBe(true)
    expect(result.current).toBe(true)
  })
})

describe('flushTabSession', () => {
  it('writes current tabs and activeTabId to the memlore-tabs key', () => {
    const tab = makeTab({ id: 'flush-tab' })
    seedStore([tab], 'flush-tab')
    localStorage.clear()
    expect(localStorage.getItem('memlore-tabs')).toBeNull()

    flushTabSession()

    const stored = localStorage.getItem('memlore-tabs')
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!) as {
      state: { tabs: { id: string }[]; activeTabId: string }
    }
    expect(parsed.state.tabs[0].id).toBe('flush-tab')
    expect(parsed.state.activeTabId).toBe('flush-tab')
  })

  it('is safe to call more than once', () => {
    const tab = makeTab({ id: 'flush-tab' })
    seedStore([tab], 'flush-tab')
    localStorage.clear()

    flushTabSession()
    flushTabSession()

    const parsed = readStoredSession()
    expect(parsed?.tabs[0].id).toBe('flush-tab')
  })

  it('does not persist the seed tab over a still-unread session', () => {
    const unread = makeTab({ id: 'unread-tab', activeView: 'calendar' })
    seedStore([makeTab({ id: 'seed-tab' })], 'seed-tab')
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: [unread], activeTabId: 'unread-tab' }, version: 0 }),
    )
    vi.spyOn(useTabStore.persist, 'hasHydrated').mockReturnValue(false)

    flushTabSession()

    const parsed = readStoredSession()
    expect(parsed?.tabs[0].id).toBe('unread-tab')
    expect(parsed?.activeTabId).toBe('unread-tab')
  })
})

describe('useFlushTabSessionOnClose', () => {
  it('flushes when the Tauri close handler fires', async () => {
    seedStore([makeTab({ id: 'close-tab' })], 'close-tab')
    renderHook(() => useFlushTabSessionOnClose())
    await act(async () => {
      await Promise.resolve()
    })
    localStorage.clear()

    expect(closeHandlers.length).toBeGreaterThan(0)
    act(() => {
      closeHandlers[0]()
    })

    const parsed = readStoredSession()
    expect(parsed?.tabs[0].id).toBe('close-tab')
    expect(parsed?.activeTabId).toBe('close-tab')
  })

  it('flushes on pagehide', () => {
    seedStore([makeTab({ id: 'hide-tab' })], 'hide-tab')
    renderHook(() => useFlushTabSessionOnClose())
    localStorage.clear()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    const parsed = readStoredSession()
    expect(parsed?.tabs[0].id).toBe('hide-tab')
  })

  it('flushes on visibilitychange when the document is hidden', () => {
    seedStore([makeTab({ id: 'hidden-tab' })], 'hidden-tab')
    renderHook(() => useFlushTabSessionOnClose())
    localStorage.clear()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    const parsed = readStoredSession()
    expect(parsed?.tabs[0].id).toBe('hidden-tab')
  })

  it('does not flush on visibilitychange while visible', () => {
    seedStore([makeTab({ id: 'visible-tab' })], 'visible-tab')
    renderHook(() => useFlushTabSessionOnClose())
    localStorage.clear()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(localStorage.getItem('memlore-tabs')).toBeNull()
  })

  it('removes listeners on unmount so pagehide does not persist again', () => {
    seedStore([makeTab({ id: 'unmount-tab' })], 'unmount-tab')
    const { unmount } = renderHook(() => useFlushTabSessionOnClose())
    unmount()
    localStorage.clear()

    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow()
    expect(localStorage.getItem('memlore-tabs')).toBeNull()
  })
})
