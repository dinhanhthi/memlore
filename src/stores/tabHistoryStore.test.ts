import { describe, it, expect, beforeEach } from 'vitest'
import {
  useTabHistoryStore,
  snapshotFromTab,
  patchAffectsNav,
  type NavSnapshot,
} from './tabHistoryStore'
import { makeDefaultTab, type Tab } from './tabStore'

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    ...makeDefaultTab(),
    id: 'tab-1',
    dirty: false,
    pinned: false,
    ...overrides,
  }
}

function snap(overrides: Partial<NavSnapshot> = {}): NavSnapshot {
  return {
    journalId: null,
    activeView: 'entries',
    selectedEntryId: null,
    selectedCalendarDate: null,
    selectedTagId: null,
    selectedChatSessionId: null,
    pagination: undefined,
    settingsCategory: 'security',
    securityTab: 'device_password',
    locationTab: 'geocoding',
    aiTab: 'chat',
    templatesTab: 'custom',
    dataTab: 'import',
    editorTab: 'general',
    syncTab: 'gdrive',
    statsTab: 'charts',
    ...overrides,
  }
}

beforeEach(() => {
  useTabHistoryStore.setState({ histories: {}, isRestoring: false })
})

describe('snapshotFromTab', () => {
  it('copies only nav-relevant fields', () => {
    const tab = makeTab({
      id: 'x',
      selectedEntryId: 'e1',
      dirty: true,
      pinned: true,
      pagination: { all: 3 },
      settingsCategory: 'ai',
      statsTab: 'usage',
    })
    const s = snapshotFromTab(tab)
    expect(s).toEqual({
      journalId: null,
      activeView: 'dashboard',
      selectedEntryId: 'e1',
      selectedCalendarDate: null,
      selectedTagId: null,
      selectedChatSessionId: null,
      pagination: { all: 3 },
      settingsCategory: 'ai',
      securityTab: 'device_password',
      locationTab: 'geocoding',
      aiTab: 'chat',
      templatesTab: 'custom',
      dataTab: 'import',
      editorTab: 'general',
      syncTab: 'gdrive',
      statsTab: 'usage',
    })
    // Sanity: dirty/pinned not present
    expect('dirty' in s).toBe(false)
    expect('pinned' in s).toBe(false)
  })

  it('includes selectedChatSessionId so Daily Chat selection survives back/forward', () => {
    const tab = makeTab({
      activeView: 'chat',
      selectedChatSessionId: 'sess-abc',
    })
    const s = snapshotFromTab(tab)
    expect(s.activeView).toBe('chat')
    expect(s.selectedChatSessionId).toBe('sess-abc')
  })

  it('includes settingsCategory and statsTab so settings/stats nav survives back/forward', () => {
    const tab = makeTab({
      activeView: 'settings',
      settingsCategory: 'sync',
      syncTab: 'devices',
      statsTab: 'audit',
    })
    const s = snapshotFromTab(tab)
    expect(s.settingsCategory).toBe('sync')
    expect(s.syncTab).toBe('devices')
    expect(s.statsTab).toBe('audit')
  })
})

describe('patchAffectsNav', () => {
  const base = makeTab({ selectedEntryId: 'e1', activeView: 'entries' })

  it('false for empty patch', () => {
    expect(patchAffectsNav(base, {})).toBe(false)
  })

  it('false for dirty-only patch', () => {
    expect(patchAffectsNav(base, { dirty: true })).toBe(false)
  })

  it('false for pinned-only patch', () => {
    expect(patchAffectsNav(base, { pinned: true })).toBe(false)
  })

  it('true when activeView changes', () => {
    expect(patchAffectsNav(base, { activeView: 'calendar' })).toBe(true)
  })

  it('true when selectedEntryId changes', () => {
    expect(patchAffectsNav(base, { selectedEntryId: 'e2' })).toBe(true)
  })

  it('true when selectedChatSessionId changes', () => {
    expect(patchAffectsNav(base, { selectedChatSessionId: 'sess-2' })).toBe(true)
  })

  it('true when settingsCategory changes', () => {
    expect(patchAffectsNav(base, { settingsCategory: 'ai' })).toBe(true)
  })

  it('true when statsTab changes', () => {
    expect(patchAffectsNav(base, { statsTab: 'usage' })).toBe(true)
  })

  it('true when a settings sub-tab changes', () => {
    expect(patchAffectsNav(base, { securityTab: 'second_lock' })).toBe(true)
  })

  it('false when patch sets same value', () => {
    expect(patchAffectsNav(base, { selectedEntryId: 'e1' })).toBe(false)
  })

  it('true when pagination changes by content (different refs, different values)', () => {
    const b = makeTab({ pagination: { all: 1 } })
    expect(patchAffectsNav(b, { pagination: { all: 2 } })).toBe(true)
  })

  it('false when pagination is equivalent by content (different refs, same values)', () => {
    const b = makeTab({ pagination: { all: 1 } })
    expect(patchAffectsNav(b, { pagination: { all: 1 } })).toBe(false)
  })
})

describe('pushHistory', () => {
  it('pushes onto back stack and clears forward', () => {
    const s = useTabHistoryStore.getState()
    s.pushHistory('tab-1', snap({ selectedEntryId: 'a' }))
    // Seed a forward entry the only legitimate way: pop a back, push to forward
    s.pushHistory('tab-1', snap({ selectedEntryId: 'b' }))
    s.popBack('tab-1', snap({ selectedEntryId: 'now' }))
    expect(useTabHistoryStore.getState().histories['tab-1'].forward).toHaveLength(1)

    s.pushHistory('tab-1', snap({ selectedEntryId: 'c' }))
    const h = useTabHistoryStore.getState().histories['tab-1']
    expect(h.forward).toHaveLength(0)
  })

  it('dedups against top of back stack', () => {
    const s = useTabHistoryStore.getState()
    s.pushHistory('tab-1', snap({ selectedEntryId: 'a' }))
    s.pushHistory('tab-1', snap({ selectedEntryId: 'a' }))
    expect(useTabHistoryStore.getState().histories['tab-1'].back).toHaveLength(1)
  })

  it('caps at 50 entries — oldest dropped', () => {
    const s = useTabHistoryStore.getState()
    for (let i = 0; i < 60; i++) {
      s.pushHistory('tab-1', snap({ selectedEntryId: `e-${i}` }))
    }
    const back = useTabHistoryStore.getState().histories['tab-1'].back
    expect(back).toHaveLength(50)
    expect(back[0].selectedEntryId).toBe('e-10')
    expect(back[49].selectedEntryId).toBe('e-59')
  })
})

describe('popBack / popForward', () => {
  it('popBack returns null when empty', () => {
    const s = useTabHistoryStore.getState()
    expect(s.popBack('tab-1', snap())).toBeNull()
  })

  it('popBack returns top and shifts current onto forward', () => {
    const s = useTabHistoryStore.getState()
    s.pushHistory('tab-1', snap({ selectedEntryId: 'old' }))
    const result = s.popBack('tab-1', snap({ selectedEntryId: 'now' }))
    expect(result?.selectedEntryId).toBe('old')
    const h = useTabHistoryStore.getState().histories['tab-1']
    expect(h.back).toHaveLength(0)
    expect(h.forward).toHaveLength(1)
    expect(h.forward[0].selectedEntryId).toBe('now')
  })

  it('popForward mirrors popBack', () => {
    const s = useTabHistoryStore.getState()
    s.pushHistory('tab-1', snap({ selectedEntryId: 'a' }))
    s.popBack('tab-1', snap({ selectedEntryId: 'b' }))
    const result = s.popForward('tab-1', snap({ selectedEntryId: 'a' }))
    expect(result?.selectedEntryId).toBe('b')
  })

  it('popForward returns null when empty', () => {
    const s = useTabHistoryStore.getState()
    expect(s.popForward('tab-1', snap())).toBeNull()
  })
})

describe('canGoBack / canGoForward', () => {
  it('false for unknown tab', () => {
    const s = useTabHistoryStore.getState()
    expect(s.canGoBack('nope')).toBe(false)
    expect(s.canGoForward('nope')).toBe(false)
  })

  it('toggle as the stacks fill', () => {
    const s = useTabHistoryStore.getState()
    s.pushHistory('tab-1', snap({ selectedEntryId: 'a' }))
    expect(s.canGoBack('tab-1')).toBe(true)
    expect(s.canGoForward('tab-1')).toBe(false)
    s.popBack('tab-1', snap({ selectedEntryId: 'now' }))
    expect(s.canGoBack('tab-1')).toBe(false)
    expect(s.canGoForward('tab-1')).toBe(true)
  })
})

describe('clearHistory', () => {
  it('drops the tab entry', () => {
    const s = useTabHistoryStore.getState()
    s.pushHistory('tab-1', snap({ selectedEntryId: 'a' }))
    s.clearHistory('tab-1')
    expect(useTabHistoryStore.getState().histories['tab-1']).toBeUndefined()
  })

  it('no-op for missing tab', () => {
    const s = useTabHistoryStore.getState()
    expect(() => s.clearHistory('nope')).not.toThrow()
  })
})

describe('isRestoring flag', () => {
  it('defaults to false', () => {
    expect(useTabHistoryStore.getState().isRestoring).toBe(false)
  })

  it('setRestoring toggles', () => {
    useTabHistoryStore.getState().setRestoring(true)
    expect(useTabHistoryStore.getState().isRestoring).toBe(true)
    useTabHistoryStore.getState().setRestoring(false)
    expect(useTabHistoryStore.getState().isRestoring).toBe(false)
  })
})
