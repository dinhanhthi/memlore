import { describe, it, expect, beforeEach } from 'vitest'
import { useSecondLockStore } from './secondLockStore'
import { useEntryStore } from './entryStore'
import { useTabStore, makeDefaultTab, type Tab } from './tabStore'
import { snapshotFromTab, useTabHistoryStore } from './tabHistoryStore'
import type { Entry } from '../types/entry'

function makeEntry(id: string, isLocked: boolean): Entry {
  return {
    id,
    journal_id: 'journal-1',
    title: id,
    preview_text: null,
    content_text: null,
    entry_date: 1_700_000_000,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    latitude: null,
    longitude: null,
    location_label: null,
    location_address: null,
    weather_summary: null,
    weather_icon: null,
    emotion: null,
    is_favorite: false,
    is_deleted: false,
    is_locked: isLocked,
    is_invisible: false,
    vault_id: null,
    cover_media_id: null,
    media_count: 0,
    from_chat: false,
    content_language: null,
    entry_date_user_edited: false,
  }
}

function makeTab(id: string, selectedEntryId: string | null): Tab {
  return {
    ...makeDefaultTab(),
    id,
    selectedEntryId,
  }
}

function resetStore() {
  useSecondLockStore.setState({
    isEnabled: false,
    isSessionUnlocked: false,
    showExistence: false,
    autoLockMinutes: 5,
  })
  useEntryStore.setState({
    entries: [],
    entriesById: {},
    isLoading: false,
    error: null,
  })
  useTabStore.setState({
    tabs: [makeTab('tab-default', null)],
    activeTabId: 'tab-default',
  })
  useTabHistoryStore.setState({ histories: {}, isRestoring: false })
}

describe('secondLockStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('starts disabled, locked, revealed, and with a 5 minute auto-lock', () => {
    const store = useSecondLockStore.getState()

    expect(store.isEnabled).toBe(false)
    expect(store.isSessionUnlocked).toBe(false)
    expect(store.showExistence).toBe(false)
    expect(store.autoLockMinutes).toBe(5)
    expect(store.lockedView()).toBe('revealed')
  })

  it('unlockSession and lockSession toggle only the ephemeral session state', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()

    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(true)
    expect(useSecondLockStore.getState().lockedView()).toBe('revealed')

    useSecondLockStore.getState().lockSession()

    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
    expect(useSecondLockStore.getState().lockedView()).toBe('hidden')
  })

  it('lockSession clears revealed access while keeping second lock enabled', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()

    useSecondLockStore.getState().lockSession()

    expect(useSecondLockStore.getState().isEnabled).toBe(true)
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
    expect(useSecondLockStore.getState().lockedView()).toBe('hidden')
  })

  it('lockSession closes open tabs that point at known second-locked entries', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()
    useEntryStore
      .getState()
      .mergeEntries([makeEntry('entry-locked', true), makeEntry('entry-open', false)])
    useTabStore.setState({
      tabs: [makeTab('tab-locked', 'entry-locked'), makeTab('tab-open', 'entry-open')],
      activeTabId: 'tab-locked',
    })
    useTabHistoryStore.setState({
      histories: {
        'tab-locked': {
          back: [snapshotFromTab(makeTab('tab-locked', 'entry-locked'))],
          forward: [],
        },
      },
      isRestoring: false,
    })

    useSecondLockStore.getState().lockSession()

    expect(useTabStore.getState().tabs.map((tab) => tab.id)).toEqual(['tab-open'])
    expect(useTabStore.getState().activeTabId).toBe('tab-open')
    expect(useTabHistoryStore.getState().histories).toEqual({})
  })

  it('lockSession closes open tabs for entries locked through their journal', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()
    useEntryStore
      .getState()
      .mergeEntries([makeEntry('entry-in-locked-journal', true), makeEntry('entry-open', false)])
    useTabStore.setState({
      tabs: [
        makeTab('tab-journal-locked', 'entry-in-locked-journal'),
        makeTab('tab-open', 'entry-open'),
      ],
      activeTabId: 'tab-journal-locked',
    })

    useSecondLockStore.getState().lockSession()

    expect(useTabStore.getState().tabs.map((tab) => tab.id)).toEqual(['tab-open'])
    expect(useTabStore.getState().activeTabId).toBe('tab-open')
  })

  it('lockSession clears history even when the current tab is not on a locked entry', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()
    useEntryStore.getState().mergeEntries([makeEntry('entry-locked', true)])
    useTabStore.setState({
      tabs: [makeTab('tab-open', null)],
      activeTabId: 'tab-open',
    })
    useTabHistoryStore.setState({
      histories: {
        'tab-open': {
          back: [snapshotFromTab(makeTab('tab-open', 'entry-locked'))],
          forward: [],
        },
      },
      isRestoring: false,
    })

    useSecondLockStore.getState().lockSession()

    expect(useTabStore.getState().tabs.map((tab) => tab.id)).toEqual(['tab-open'])
    expect(useTabHistoryStore.getState().histories).toEqual({})
  })

  it('lockedView returns covered when locked rows should leave placeholders', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().setShowExistence(true)

    expect(useSecondLockStore.getState().lockedView()).toBe('covered')
  })

  it('lockedView returns revealed when the second-lock session is unlocked', () => {
    useSecondLockStore.getState().setShowExistence(false)
    useSecondLockStore.getState().unlockSession()

    expect(useSecondLockStore.getState().lockedView()).toBe('revealed')
  })

  it('disabling the feature also locks the session', () => {
    useSecondLockStore.getState().setEnabled(true)
    useSecondLockStore.getState().unlockSession()

    useSecondLockStore.getState().setEnabled(false)

    expect(useSecondLockStore.getState().isEnabled).toBe(false)
    expect(useSecondLockStore.getState().isSessionUnlocked).toBe(false)
  })

  it('updates showExistence and clamps autoLockMinutes to zero or higher', () => {
    useSecondLockStore.getState().setShowExistence(true)
    useSecondLockStore.getState().setAutoLockMinutes(15)

    expect(useSecondLockStore.getState().showExistence).toBe(true)
    expect(useSecondLockStore.getState().autoLockMinutes).toBe(15)

    useSecondLockStore.getState().setAutoLockMinutes(-3)

    expect(useSecondLockStore.getState().autoLockMinutes).toBe(0)
  })
})
