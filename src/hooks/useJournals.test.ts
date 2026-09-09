import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useJournals } from './useJournals'
import { useJournalStore } from '../stores/journalStore'
import type { Journal } from '../types/journal'

vi.mock('../lib/tauri', () => ({
  listJournals: vi.fn(),
  createJournal: vi.fn(),
  updateJournal: vi.fn(),
  deleteJournal: vi.fn(),
  countEntriesInJournal: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeJournal = (overrides: Partial<Journal> = {}): Journal => ({
  id: 'journal-1',
  name: 'My Journal',
  color: null,
  created_at: 1744640400000,
  updated_at: 1744640400000,
  sort_order: 0,
  is_deleted: false,
  is_locked: false,
  is_invisible: false,
  vault_id: null,
  is_initial_placeholder: false,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  useJournalStore.setState({
    journals: [],
    activeJournalId: null,
  })
})

describe('useJournals', () => {
  it('fetches journals on mount', async () => {
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal()])

    const { result } = renderHook(() => useJournals())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(tauri.listJournals).toHaveBeenCalledOnce()
    expect(result.current.journals).toHaveLength(1)
  })

  it('does not auto-select first journal — null (All Journals) is valid default', async () => {
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal({ id: 'j1' })])

    renderHook(() => useJournals())

    await waitFor(() => {
      // activeJournalId should remain null (All Journals view)
      expect(useJournalStore.getState().activeJournalId).toBeNull()
    })
  })

  it('preserves existing activeJournalId', async () => {
    useJournalStore.setState({ activeJournalId: 'existing-id' })
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal({ id: 'j1' })])

    renderHook(() => useJournals())

    await waitFor(() => {
      expect(useJournalStore.getState().activeJournalId).toBe('existing-id')
    })
  })

  it('returns activeJournal matching activeJournalId', async () => {
    useJournalStore.setState({ activeJournalId: 'j1' })
    const journal = makeJournal({ id: 'j1', name: 'Active Journal' })
    vi.mocked(tauri.listJournals).mockResolvedValue([journal])

    const { result } = renderHook(() => useJournals())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.activeJournal?.name).toBe('Active Journal')
  })

  it('returns null activeJournal when activeJournalId is null', async () => {
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal({ id: 'j1' })])

    const { result } = renderHook(() => useJournals())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.activeJournal).toBeNull()
    expect(result.current.activeJournalId).toBeNull()
  })

  it('sets error on fetch failure', async () => {
    vi.mocked(tauri.listJournals).mockRejectedValue(new Error('Failed'))

    const { result } = renderHook(() => useJournals())

    await waitFor(() => {
      expect(result.current.error).toBeTruthy()
    })
  })

  it('sets isLoading during fetch', async () => {
    let resolve!: (journals: Journal[]) => void
    vi.mocked(tauri.listJournals).mockReturnValue(
      new Promise<Journal[]>((r) => {
        resolve = r
      }),
    )

    const { result } = renderHook(() => useJournals())

    expect(result.current.isLoading).toBe(true)

    resolve([])

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
  })

  it('createJournal calls tauri and refreshes list', async () => {
    const created = makeJournal({ id: 'new-j', name: 'New One' })
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal()])
    vi.mocked(tauri.createJournal).mockResolvedValue(created)

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // After createJournal, listJournals is called again to refresh
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal(), created])

    await act(async () => {
      await result.current.createJournal('New One', '#FF0000')
    })

    expect(tauri.createJournal).toHaveBeenCalledWith('New One', '#FF0000', [])
    expect(result.current.journals).toHaveLength(2)
  })

  it('deleteJournal calls tauri and refreshes list', async () => {
    const j1 = makeJournal({ id: 'j1' })
    const j2 = makeJournal({ id: 'j2', name: 'Second' })
    vi.mocked(tauri.listJournals).mockResolvedValue([j1, j2])
    vi.mocked(tauri.deleteJournal).mockResolvedValue(undefined)

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    vi.mocked(tauri.listJournals).mockResolvedValue([j1])

    await act(async () => {
      await result.current.deleteJournal('j2')
    })

    expect(tauri.deleteJournal).toHaveBeenCalledWith('j2')
    expect(result.current.journals).toHaveLength(1)
  })

  it('deleteJournal fans out entries-changed so the entry list refetches', async () => {
    // The backend soft-deletes every entry in the journal. Without this event
    // the ['entries'] query cache (staleTime 30s, no refetch-on-focus) keeps
    // showing the deleted journal's entries.
    const j1 = makeJournal({ id: 'j1' })
    const j2 = makeJournal({ id: 'j2', name: 'Second' })
    vi.mocked(tauri.listJournals).mockResolvedValue([j1, j2])
    vi.mocked(tauri.deleteJournal).mockResolvedValue(undefined)

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const onEntriesChanged = vi.fn()
    window.addEventListener('memlore:entries-changed', onEntriesChanged)
    vi.mocked(tauri.listJournals).mockResolvedValue([j1])

    await act(async () => {
      await result.current.deleteJournal('j2')
    })
    window.removeEventListener('memlore:entries-changed', onEntriesChanged)

    expect(onEntriesChanged).toHaveBeenCalledTimes(1)
  })

  it('deleteJournal switches active to first journal if deleted was active', async () => {
    const j1 = makeJournal({ id: 'j1' })
    const j2 = makeJournal({ id: 'j2' })
    vi.mocked(tauri.listJournals).mockResolvedValue([j1, j2])
    vi.mocked(tauri.deleteJournal).mockResolvedValue(undefined)
    useJournalStore.setState({ activeJournalId: 'j2' })

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    vi.mocked(tauri.listJournals).mockResolvedValue([j1])

    await act(async () => {
      await result.current.deleteJournal('j2')
    })

    expect(useJournalStore.getState().activeJournalId).toBe('j1')
  })

  it('getEntryCount calls countEntriesInJournal', async () => {
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal()])
    vi.mocked(tauri.countEntriesInJournal).mockResolvedValue(5)

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const count = await result.current.getEntryCount('journal-1')
    expect(count).toBe(5)
    expect(tauri.countEntriesInJournal).toHaveBeenCalledWith('journal-1')
  })

  it('setActiveJournal updates store', async () => {
    vi.mocked(tauri.listJournals).mockResolvedValue([makeJournal()])

    const { result } = renderHook(() => useJournals())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setActiveJournal(null)
    })
    expect(useJournalStore.getState().activeJournalId).toBeNull()

    act(() => {
      result.current.setActiveJournal('j-abc')
    })
    expect(useJournalStore.getState().activeJournalId).toBe('j-abc')
  })
})
