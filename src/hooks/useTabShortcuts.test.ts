import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { makeDefaultTab, useTabStore } from '../stores/tabStore'
import type { Tab } from '../stores/tabStore'
import { useTabShortcuts } from './useTabShortcuts'

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

function fireKey(
  key: string,
  opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; target?: EventTarget } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  })
  if (opts.target) {
    Object.defineProperty(event, 'target', { value: opts.target, configurable: true })
  }
  window.dispatchEvent(event)
  return event
}

const addedElements: HTMLElement[] = []

function makeFocusedInput(
  tag: 'input' | 'textarea' | 'div',
  contenteditable?: boolean,
): HTMLElement {
  const el = document.createElement(tag)
  if (contenteditable) {
    el.setAttribute('contenteditable', 'true')
  }
  document.body.appendChild(el)
  addedElements.push(el)
  el.focus()
  return el
}

beforeEach(() => {
  addedElements.length = 0
  seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-1')
})

afterEach(async () => {
  // Clean up any elements added to body
  for (const el of addedElements) {
    el.remove()
  }
  addedElements.length = 0
  // Flush requestCloseActiveTab's same-tick gate between tests.
  await Promise.resolve()
})

describe('useTabShortcuts', () => {
  it('registers a keydown event listener on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useTabShortcuts())
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    addSpy.mockRestore()
  })

  it('removes the keydown listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useTabShortcuts())
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    removeSpy.mockRestore()
  })

  describe('⌘T — new tab', () => {
    it('opens a new tab on ⌘T', () => {
      renderHook(() => useTabShortcuts())
      fireKey('t', { metaKey: true })
      expect(useTabStore.getState().tabs).toHaveLength(3)
    })

    // Text-input guard removed in Chunk D: ⌘-prefixed shortcuts don't
    // conflict with normal typing and users expect them to work even while
    // writing in the TipTap editor (which is a contenteditable). Mirror
    // browser behavior — ⌘T opens a tab from anywhere.
    it('⌘T DOES fire when an <input> has focus', () => {
      renderHook(() => useTabShortcuts())
      const input = makeFocusedInput('input')
      fireKey('t', { metaKey: true, target: input })
      expect(useTabStore.getState().tabs).toHaveLength(3)
    })

    it('⌘T DOES fire when a <textarea> has focus', () => {
      renderHook(() => useTabShortcuts())
      const textarea = makeFocusedInput('textarea')
      fireKey('t', { metaKey: true, target: textarea })
      expect(useTabStore.getState().tabs).toHaveLength(3)
    })

    it('⌘T DOES fire when a [contenteditable] (TipTap editor) has focus', () => {
      renderHook(() => useTabShortcuts())
      const div = makeFocusedInput('div', true)
      fireKey('t', { metaKey: true, target: div })
      expect(useTabStore.getState().tabs).toHaveLength(3)
    })
  })

  describe('⌘W — close tab', () => {
    it('closes the active tab on ⌘W', () => {
      renderHook(() => useTabShortcuts())
      fireKey('w', { metaKey: true })
      expect(useTabStore.getState().tabs).toHaveLength(1)
    })

    it('⌘W DOES fire even when an <input> has focus', () => {
      renderHook(() => useTabShortcuts())
      const input = makeFocusedInput('input')
      fireKey('w', { metaKey: true, target: input })
      // ⌘W is always unambiguous — should still close
      expect(useTabStore.getState().tabs).toHaveLength(1)
    })

    it('⌘W on the last tab dispatches request-quit (does not drop the tab)', () => {
      seedStore([makeTab({ id: 'only' })], 'only')
      const handler = vi.fn()
      window.addEventListener('memlore:request-quit', handler)
      renderHook(() => useTabShortcuts())
      fireKey('w', { metaKey: true })
      expect(useTabStore.getState().tabs).toHaveLength(1)
      expect(handler).toHaveBeenCalledTimes(1)
      window.removeEventListener('memlore:request-quit', handler)
    })
  })

  describe('⌘1..9 — switch by index', () => {
    it('⌘1 switches to the first tab (index 0)', () => {
      seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-2')
      renderHook(() => useTabShortcuts())
      fireKey('1', { metaKey: true })
      expect(useTabStore.getState().activeTabId).toBe('tab-1')
    })

    it('⌘2 switches to the second tab (index 1)', () => {
      seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-1')
      renderHook(() => useTabShortcuts())
      fireKey('2', { metaKey: true })
      expect(useTabStore.getState().activeTabId).toBe('tab-2')
    })

    it('⌘1 DOES fire when an <input> has focus', () => {
      seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-2')
      renderHook(() => useTabShortcuts())
      const input = makeFocusedInput('input')
      fireKey('1', { metaKey: true, target: input })
      expect(useTabStore.getState().activeTabId).toBe('tab-1')
    })
  })

  describe('⌘Shift+Arrow — prev/next tab', () => {
    it('⌘Shift+ArrowRight switches to the next tab', () => {
      seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-1')
      renderHook(() => useTabShortcuts())
      fireKey('ArrowRight', { metaKey: true, shiftKey: true })
      expect(useTabStore.getState().activeTabId).toBe('tab-2')
    })

    it('⌘Shift+ArrowLeft switches to the previous tab', () => {
      seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-2')
      renderHook(() => useTabShortcuts())
      fireKey('ArrowLeft', { metaKey: true, shiftKey: true })
      expect(useTabStore.getState().activeTabId).toBe('tab-1')
    })

    it('⌘Shift+Arrow wraps from first to last', () => {
      seedStore(
        [makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' }), makeTab({ id: 'tab-3' })],
        'tab-1',
      )
      renderHook(() => useTabShortcuts())
      fireKey('ArrowLeft', { metaKey: true, shiftKey: true })
      expect(useTabStore.getState().activeTabId).toBe('tab-3')
    })

    it('⌘Shift+Arrow wraps from last to first', () => {
      seedStore(
        [makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' }), makeTab({ id: 'tab-3' })],
        'tab-3',
      )
      renderHook(() => useTabShortcuts())
      fireKey('ArrowRight', { metaKey: true, shiftKey: true })
      expect(useTabStore.getState().activeTabId).toBe('tab-1')
    })

    it('⌘Shift+Arrow DOES fire even when <input> has focus', () => {
      seedStore([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })], 'tab-1')
      renderHook(() => useTabShortcuts())
      const input = makeFocusedInput('input')
      fireKey('ArrowRight', { metaKey: true, shiftKey: true, target: input })
      expect(useTabStore.getState().activeTabId).toBe('tab-2')
    })
  })
})
