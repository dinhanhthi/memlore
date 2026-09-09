import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useInvisibleLock } from './useInvisibleLock'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useEntryStore } from '../stores/entryStore'
import { useTabStore, makeDefaultTab, type Tab } from '../stores/tabStore'
import type { Entry } from '../types/entry'
import * as tauri from '../lib/tauri'

vi.mock('../lib/tauri', () => ({
  getSetting: vi.fn(),
  openOrCreateInvisibleVault: vi.fn(),
  changeInvisibleVaultPassword: vi.fn(),
  removeEmptyInvisibleVaults: vi.fn(),
  setEntryInvisible: vi.fn(),
  setJournalInvisible: vi.fn(),
  setSetting: vi.fn(),
}))

const getSettingMock = vi.mocked(tauri.getSetting)
const setSettingMock = vi.mocked(tauri.setSetting)
const openOrCreateMock = vi.mocked(tauri.openOrCreateInvisibleVault)
const changePasswordMock = vi.mocked(tauri.changeInvisibleVaultPassword)
const removeEmptyMock = vi.mocked(tauri.removeEmptyInvisibleVaults)
const setEntryInvisibleMock = vi.mocked(tauri.setEntryInvisible)
const setJournalInvisibleMock = vi.mocked(tauri.setJournalInvisible)

function resetStore() {
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
  useTabStore.setState({
    tabs: [
      {
        ...makeDefaultTab(),
        id: 'tab-default',
        journalId: null,
        activeView: 'entries',
        selectedEntryId: null,
        selectedCalendarDate: null,
        selectedTagId: null,
        selectedChatSessionId: null,
        dirty: false,
        pinned: false,
      },
    ],
    activeTabId: 'tab-default',
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  resetStore()
  getSettingMock.mockResolvedValue(null)
  setSettingMock.mockResolvedValue(undefined)
  openOrCreateMock.mockResolvedValue('vault-a')
  changePasswordMock.mockResolvedValue('vault-a')
  removeEmptyMock.mockResolvedValue(undefined)
  setEntryInvisibleMock.mockResolvedValue(undefined)
  setJournalInvisibleMock.mockResolvedValue(undefined)
})

describe('useInvisibleLock', () => {
  it('hydrates persisted auto-lock minutes on mount', async () => {
    getSettingMock.mockResolvedValue('12')

    const { result } = renderHook(() => useInvisibleLock())

    await waitFor(() => expect(result.current.autoLockMinutes).toBe(12))
    expect(getSettingMock).toHaveBeenCalledWith('invisible_lock_auto_lock_minutes')
  })

  it('can skip hydration when the real database is not ready yet', () => {
    renderHook(() => useInvisibleLock(false))

    expect(getSettingMock).not.toHaveBeenCalled()
  })

  it('openOrCreate unlocks the session to the returned vault id', async () => {
    openOrCreateMock.mockResolvedValueOnce('vault-new')
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      expect(await result.current.openOrCreate('secret')).toBe('vault-new')
    })
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-new')
    expect(openOrCreateMock).toHaveBeenCalledWith('secret')
  })

  it('openOrCreate replaces any previously open vault', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-old' })
    openOrCreateMock.mockResolvedValueOnce('vault-b')
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      await result.current.openOrCreate('other')
    })
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-b')
  })

  it('changePassword updates active vault and handles merge target id', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    changePasswordMock.mockResolvedValueOnce('vault-b')
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      expect(await result.current.changePassword('old', 'new')).toBe('vault-b')
    })
    expect(changePasswordMock).toHaveBeenCalledWith('vault-a', 'old', 'new')
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-b')
  })

  it('changePassword rejects when no vault is open', async () => {
    const { result } = renderHook(() => useInvisibleLock(false))

    await expect(result.current.changePassword('old', 'new')).rejects.toThrow(
      'No invisible vault is open',
    )
    expect(changePasswordMock).not.toHaveBeenCalled()
  })

  it('removeEmptyVaults forwards to the backend', async () => {
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      await result.current.removeEmptyVaults()
    })
    expect(removeEmptyMock).toHaveBeenCalledOnce()
  })

  it('persists auto-lock minutes before updating the store', async () => {
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      await result.current.setAutoLockMinutes(0)
    })

    expect(setSettingMock).toHaveBeenCalledWith('invisible_lock_auto_lock_minutes', '0')
    expect(useInvisibleLockStore.getState().autoLockMinutes).toBe(0)
  })

  it('forwards entry and journal invisible toggles with activeVaultId', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      await result.current.markEntryInvisible('entry-1', true)
      await result.current.markJournalInvisible('journal-1', false)
    })

    expect(setEntryInvisibleMock).toHaveBeenCalledWith('entry-1', true, 'vault-a')
    expect(setJournalInvisibleMock).toHaveBeenCalledWith('journal-1', false, null)
  })

  it('markEntryInvisibleWithPassword marks without unlocking the session', async () => {
    openOrCreateMock.mockResolvedValueOnce('vault-secret')
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      expect(await result.current.markEntryInvisibleWithPassword('entry-1', 'pass')).toBe(
        'vault-secret',
      )
    })

    expect(openOrCreateMock).toHaveBeenCalledWith('pass')
    expect(setEntryInvisibleMock).toHaveBeenCalledWith('entry-1', true, 'vault-secret')
    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
  })

  it('markEntryInvisibleWithPassword removes the entry from store and closes its tabs', async () => {
    const entry: Entry = {
      id: 'entry-1',
      journal_id: 'journal-1',
      title: 'Secret',
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
      is_invisible: false,
      vault_id: null,
      cover_media_id: null,
      media_count: 0,
      from_chat: false,
      content_language: null,
      entry_date_user_edited: false,
    }
    useEntryStore.setState({
      entries: [entry],
      entriesById: { [entry.id]: entry },
      isLoading: false,
      error: null,
    })
    const tab: Tab = {
      ...makeDefaultTab(),
      id: 'tab-1',
      journalId: null,
      activeView: 'entries',
      selectedEntryId: entry.id,
      selectedCalendarDate: null,
      selectedTagId: null,
      selectedChatSessionId: null,
      dirty: false,
      pinned: false,
    }
    useTabStore.setState({ tabs: [tab], activeTabId: 'tab-1' })
    openOrCreateMock.mockResolvedValueOnce('vault-secret')
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      await result.current.markEntryInvisibleWithPassword(entry.id, 'pass')
    })

    expect(useInvisibleLockStore.getState().activeVaultId).toBeNull()
    expect(useEntryStore.getState().entriesById[entry.id]).toBeUndefined()
    expect(useEntryStore.getState().entries).toHaveLength(0)
    // Tab closed or replaced — no selectedEntryId pointing at the hidden entry.
    const tabs = useTabStore.getState().tabs
    expect(tabs.every((t) => t.selectedEntryId !== entry.id)).toBe(true)
  })

  it('markEntryInvisible patches entriesById is_invisible without unlocking', async () => {
    useInvisibleLockStore.setState({ activeVaultId: 'vault-a' })
    const entry: Entry = {
      id: 'entry-2',
      journal_id: 'journal-1',
      title: 'Visible',
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
      is_invisible: false,
      vault_id: null,
      cover_media_id: null,
      media_count: 0,
      from_chat: false,
      content_language: null,
      entry_date_user_edited: false,
    }
    useEntryStore.setState({
      entries: [entry],
      entriesById: { [entry.id]: entry },
      isLoading: false,
      error: null,
    })
    const { result } = renderHook(() => useInvisibleLock(false))

    await act(async () => {
      await result.current.markEntryInvisible(entry.id, true)
    })

    expect(setEntryInvisibleMock).toHaveBeenCalledWith(entry.id, true, 'vault-a')
    expect(useEntryStore.getState().entriesById[entry.id]?.is_invisible).toBe(true)
    expect(useEntryStore.getState().entriesById[entry.id]?.vault_id).toBe('vault-a')
    expect(useInvisibleLockStore.getState().activeVaultId).toBe('vault-a')
  })
})
