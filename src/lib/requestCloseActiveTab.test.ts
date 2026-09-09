import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeDefaultTab, useTabStore } from '../stores/tabStore'
import type { Tab } from '../stores/tabStore'
import { requestCloseActiveTab, REQUEST_QUIT_EVENT } from './requestCloseActiveTab'

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    ...makeDefaultTab(),
    id: 'tab-1',
    dirty: false,
    ...overrides,
  }
}

describe('requestCloseActiveTab', () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })],
      activeTabId: 'tab-1',
    })
  })

  afterEach(() => {
    // Drain the in-flight microtask gate so tests stay isolated.
    return Promise.resolve()
  })

  it('closes the active tab when more than one tab is open', () => {
    requestCloseActiveTab()
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(['tab-2'])
    expect(useTabStore.getState().activeTabId).toBe('tab-2')
  })

  it('dispatches request-quit when only one tab remains', () => {
    useTabStore.setState({
      tabs: [makeTab({ id: 'only' })],
      activeTabId: 'only',
    })
    const handler = vi.fn()
    window.addEventListener(REQUEST_QUIT_EVENT, handler)
    requestCloseActiveTab()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(useTabStore.getState().tabs).toHaveLength(1)
    window.removeEventListener(REQUEST_QUIT_EVENT, handler)
  })

  it('ignores a same-tick double call (menu + keydown)', () => {
    requestCloseActiveTab()
    requestCloseActiveTab()
    // Only one tab closed — not both
    expect(useTabStore.getState().tabs).toHaveLength(1)
  })
})
