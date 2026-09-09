import { beforeEach, describe, expect, it } from 'vitest'
import { hideEntryAfterMarkInvisible, useInvisibleLockStore } from './invisibleLockStore'
import { useEntryStore } from './entryStore'
import { useJournalStore } from './journalStore'
import { useTabStore, makeDefaultTab, type Tab } from './tabStore'
import { snapshotFromTab, useTabHistoryStore } from './tabHistoryStore'
import type { Entry } from '../types/entry'
import type { Journal } from '../types/journal'

function makeEntry(id: string, isInvisible: boolean): Entry {
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
    is_locked: false,
    is_invisible: isInvisible,
    vault_id: isInvisible ? 'vault-a' : null,
    cover_media_id: null,
    media_count: 0,
    from_chat: false,
    content_language: null,
    entry_date_user_edited: false,
  }
}

function makeJournal(id: string, isInvisible: boolean): Journal {
  return {
    id,
    name: id,
    color: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    sort_order: 0,
    is_deleted: false,
    is_locked: false,
    is_invisible: isInvisible,
    vault_id: isInvisible ? 'vault-a' : null,
    is_initial_placeholder: false,
  }
}

function makeTab(id: string, selectedEntryId: string | null): Tab {
  return {
    ...makeDefaultTab(),
    id,
    selectedEntryId,
  }
}

beforeEach(() => {
  useInvisibleLockStore.setState({
    activeVaultId: null,
    autoLockMinutes: 5,
  })
  useEntryStore.setState({
    entries: [],
    entriesById: {},
    isLoading: false,
    error: null,
  })
  useTabHistoryStore.setState({
    histories: {},
    isRestoring: false,
  })
  useJournalStore.setState({
    journals: [],
    activeJournalId: null,
  })
})

describe('useInvisibleLockStore', () => {
  it('unlockSession sets activeVaultId; only one vault is open at a time', () => {
    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()

    useInvisibleLockStore.getState().unlockSession('vault-a')
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')

    useInvisibleLockStore.getState().unlockSession('vault-b')
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-b')
  })

  it('lockSession closes open invisible-entry tabs and clears history', () => {
    const visible = makeEntry('entry-visible', false)
    const invisible = makeEntry('entry-invisible', true)
    useEntryStore.setState({
      entries: [visible, invisible],
      entriesById: {
        [visible.id]: visible,
        [invisible.id]: invisible,
      },
    })
    useTabStore.setState({
      tabs: [makeTab('tab-visible', visible.id), makeTab('tab-invisible', invisible.id)],
      activeTabId: 'tab-invisible',
    })
    useTabHistoryStore.setState({
      histories: {
        'tab-invisible': {
          back: [snapshotFromTab(makeTab('tab-invisible', invisible.id))],
          forward: [],
        },
      },
    })
    useInvisibleLockStore.getState().unlockSession('vault-a')

    useInvisibleLockStore.getState().lockSession()

    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0].id).toBe('tab-visible')
    expect(useTabStore.getState().activeTabId).toBe('tab-visible')
    expect(useTabHistoryStore.getState().histories).toEqual({})
  })

  it('lockSession resets a dangling invisible-journal selection', () => {
    const visible = makeJournal('journal-visible', false)
    const invisible = makeJournal('journal-invisible', true)
    useJournalStore.setState({
      journals: [visible, invisible],
      activeJournalId: invisible.id,
    })

    useInvisibleLockStore.getState().unlockSession('vault-a')
    useInvisibleLockStore.getState().lockSession()

    expect(useJournalStore.getState().activeJournalId).toBe(visible.id)
  })

  it('lockSession resets invisible-journal selection to All Journals when none are visible', () => {
    const invisible = makeJournal('journal-invisible', true)
    useJournalStore.setState({
      journals: [invisible],
      activeJournalId: invisible.id,
    })

    useInvisibleLockStore.getState().unlockSession('vault-a')
    useInvisibleLockStore.getState().lockSession()

    expect(useJournalStore.getState().activeJournalId).toBeNull()
  })

  it('unlockSession A→B clears previous vault tabs and invisible journal selection first', () => {
    const fromA = makeEntry('entry-a', true)
    fromA.vault_id = 'vault-a'
    const visible = makeEntry('entry-visible', false)
    useEntryStore.setState({
      entries: [visible, fromA],
      entriesById: {
        [visible.id]: visible,
        [fromA.id]: fromA,
      },
    })
    const journalA = makeJournal('journal-a', true)
    journalA.vault_id = 'vault-a'
    const journalVisible = makeJournal('journal-visible', false)
    useJournalStore.setState({
      journals: [journalVisible, journalA],
      activeJournalId: journalA.id,
    })
    useTabStore.setState({
      tabs: [makeTab('tab-a', fromA.id), makeTab('tab-visible', visible.id)],
      activeTabId: 'tab-a',
    })
    useTabHistoryStore.setState({
      histories: {
        'tab-a': {
          back: [snapshotFromTab(makeTab('tab-a', fromA.id))],
          forward: [],
        },
      },
    })

    useInvisibleLockStore.getState().unlockSession('vault-a')
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')

    useInvisibleLockStore.getState().unlockSession('vault-b')

    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-b')
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(['tab-visible'])
    expect(useTabStore.getState().activeTabId).toBe('tab-visible')
    expect(useTabHistoryStore.getState().histories).toEqual({})
    expect(useJournalStore.getState().activeJournalId).toBe(journalVisible.id)
  })

  it('unlockSession null→A does not clear non-invisible tabs', () => {
    const visible = makeEntry('entry-visible', false)
    useEntryStore.setState({
      entries: [visible],
      entriesById: { [visible.id]: visible },
    })
    useTabStore.setState({
      tabs: [makeTab('tab-visible', visible.id)],
      activeTabId: 'tab-visible',
    })

    useInvisibleLockStore.getState().unlockSession('vault-a')

    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')
    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0].id).toBe('tab-visible')
  })

  it('hideEntryAfterMarkInvisible removes store entry and closes its tabs', () => {
    const visible = makeEntry('entry-visible', false)
    const target = makeEntry('entry-hide', false)
    useEntryStore.setState({
      entries: [visible, target],
      entriesById: {
        [visible.id]: visible,
        [target.id]: target,
      },
    })
    useTabStore.setState({
      tabs: [makeTab('tab-hide', target.id), makeTab('tab-visible', visible.id)],
      activeTabId: 'tab-hide',
    })

    hideEntryAfterMarkInvisible(target.id, 'vault-secret')

    expect(useEntryStore.getState().entriesById[target.id]).toBeUndefined()
    expect(useEntryStore.getState().entries.map((e) => e.id)).toEqual([visible.id])
    expect(useTabStore.getState().tabs.map((t) => t.id)).toEqual(['tab-visible'])
    expect(useTabStore.getState().activeTabId).toBe('tab-visible')
  })
})
