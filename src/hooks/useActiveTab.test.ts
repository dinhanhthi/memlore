import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { makeDefaultTab, useTabStore } from '../stores/tabStore'
import type { Tab } from '../stores/tabStore'
import {
  useActiveTab,
  useActiveView,
  useSelectedEntryId,
  useSelectedCalendarDate,
  useUpdateActiveTab,
} from './useActiveTab'

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

beforeEach(() => {
  seedStore([makeTab({ id: 'tab-1' })], 'tab-1')
})

describe('useActiveTab', () => {
  it('returns the active tab', () => {
    const { result } = renderHook(() => useActiveTab())
    expect(result.current?.id).toBe('tab-1')
  })

  it('returns null if no tabs exist', () => {
    useTabStore.setState({ tabs: [], activeTabId: '' })
    const { result } = renderHook(() => useActiveTab())
    expect(result.current).toBeNull()
  })

  it('returns the correct tab when multiple tabs exist', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2', activeView: 'calendar' })
    seedStore([t1, t2], 'tab-2')
    const { result } = renderHook(() => useActiveTab())
    expect(result.current?.id).toBe('tab-2')
    expect(result.current?.activeView).toBe('calendar')
  })
})

describe('useActiveView', () => {
  it('returns the activeView of the active tab', () => {
    seedStore([makeTab({ id: 'tab-1', activeView: 'calendar' })], 'tab-1')
    const { result } = renderHook(() => useActiveView())
    expect(result.current).toBe('calendar')
  })

  it('defaults to "entries" when no active tab', () => {
    useTabStore.setState({ tabs: [], activeTabId: '' })
    const { result } = renderHook(() => useActiveView())
    expect(result.current).toBe('entries')
  })
})

describe('useSelectedEntryId', () => {
  it('returns selectedEntryId from active tab', () => {
    seedStore([makeTab({ id: 'tab-1', selectedEntryId: 'entry-xyz' })], 'tab-1')
    const { result } = renderHook(() => useSelectedEntryId())
    expect(result.current).toBe('entry-xyz')
  })

  it('returns null when no entry selected', () => {
    const { result } = renderHook(() => useSelectedEntryId())
    expect(result.current).toBeNull()
  })
})

describe('useSelectedCalendarDate', () => {
  it('returns selectedCalendarDate from active tab', () => {
    seedStore([makeTab({ id: 'tab-1', selectedCalendarDate: '2026-04-14' })], 'tab-1')
    const { result } = renderHook(() => useSelectedCalendarDate())
    expect(result.current).toBe('2026-04-14')
  })

  it('returns null when no date selected', () => {
    const { result } = renderHook(() => useSelectedCalendarDate())
    expect(result.current).toBeNull()
  })
})

describe('useUpdateActiveTab', () => {
  it('returns the updateActiveTab function', () => {
    const { result } = renderHook(() => useUpdateActiveTab())
    expect(typeof result.current).toBe('function')
  })

  it('updateActiveTab updates the active tab state', () => {
    const { result } = renderHook(() => useUpdateActiveTab())
    result.current({ selectedEntryId: 'e-123' })
    expect(useTabStore.getState().tabs[0].selectedEntryId).toBe('e-123')
  })
})
