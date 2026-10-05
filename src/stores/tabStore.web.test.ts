import { beforeEach, describe, expect, it, vi } from 'vitest'

// Web build: Dashboard and Statistics are out of scope (docs/LATER.md), so they must never be
// the view a tab opens on.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>()
  return {
    ...actual,
    isWeb: true,
    capabilities: { ...actual.capabilities, dashboard: false, stats: false },
  }
})

import { __resetLaunchViewForTests, applyLaunchView, makeDefaultTab, useTabStore } from './tabStore'
import type { Tab } from './tabStore'

function makeTab(overrides: Partial<Tab>): Tab {
  return { ...makeDefaultTab(), dirty: false, ...overrides }
}

beforeEach(() => {
  __resetLaunchViewForTests()
  useTabStore.setState({ tabs: [makeTab({ id: 'tab-1' })], activeTabId: 'tab-1' })
})

describe('tabStore on web', () => {
  it('makeDefaultTab opens on entries, not dashboard', () => {
    expect(makeDefaultTab().activeView).toBe('entries')
  })

  it('newTab opens a new tab on entries', () => {
    useTabStore.getState().newTab()
    const { tabs, activeTabId } = useTabStore.getState()
    expect(tabs.find((t) => t.id === activeTabId)?.activeView).toBe('entries')
  })

  it('applyLaunchView lands on entries and moves persisted dashboard/stats tabs off them', () => {
    useTabStore.setState({
      tabs: [
        makeTab({ id: 'tab-1', activeView: 'calendar' }),
        makeTab({ id: 'tab-2', activeView: 'dashboard' }),
        makeTab({ id: 'tab-3', activeView: 'stats' }),
        makeTab({ id: 'tab-4', activeView: 'tags' }),
      ],
      activeTabId: 'tab-1',
    })

    applyLaunchView()

    expect(useTabStore.getState().tabs.map((t) => t.activeView)).toEqual([
      'entries',
      'entries',
      'entries',
      'tags',
    ])
  })
})
