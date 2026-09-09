import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDailyChatSessions } from './useDailyChatSessions'
import { useTabStore, makeDefaultTab } from '../stores/tabStore'
import { useChatComposerAttachmentsStore } from '../stores/chatComposerAttachmentsStore'
import { useChatSessionStore } from '../stores/chatSessionStore'
import type { ChatSessionMeta } from '../types/ai'
import type { PagedResult } from '../types/pagination'

// ── Tauri event listener mock ──────────────────────────────────────────────

type Handler<T> = (event: { payload: T }) => void
const handlers: Record<string, Handler<unknown>> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, h: Handler<unknown>) => {
    handlers[name] = h
    return () => {
      delete handlers[name]
    }
  }),
}))

function emit<T>(name: string, payload: T) {
  const handler = handlers[name] as Handler<T> | undefined
  if (handler) handler({ payload })
}

// ── Tauri IPC mock ─────────────────────────────────────────────────────────

vi.mock('../lib/tauri', () => ({
  dailyChatListSessionsPaged: vi.fn(),
  dailyChatDeleteSession: vi.fn(),
  dailyChatRenameSession: vi.fn(),
  dailyChatSetSessionPinned: vi.fn(),
}))

import * as tauri from '../lib/tauri'

// ── Helpers ────────────────────────────────────────────────────────────────

const makeSession = (overrides: Partial<ChatSessionMeta> = {}): ChatSessionMeta => ({
  id: 's1',
  title: 'Session One',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  messageCount: 0,
  usedRag: false,
  pinnedAt: null,
  convertedEntryId: null,
  ...overrides,
})

const makePagedResult = (
  items: ChatSessionMeta[],
  total?: number,
): PagedResult<ChatSessionMeta> => ({
  items,
  total: total ?? items.length,
})

function seedActiveTab() {
  const tab = makeDefaultTab()
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
  return tab
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(makePagedResult([]))
  vi.mocked(tauri.dailyChatDeleteSession).mockResolvedValue(undefined)
  vi.mocked(tauri.dailyChatRenameSession).mockResolvedValue(undefined)
  vi.mocked(tauri.dailyChatSetSessionPinned).mockResolvedValue(undefined)
  useChatSessionStore.setState({ chatSessionsById: {} })
  useChatComposerAttachmentsStore.setState({ attachmentsBySessionId: {}, searchQuery: '' })
  seedActiveTab()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useDailyChatSessions', () => {
  // 1. Initial load returns paged shape
  it('returns page 1 with sessions and total after initial load', async () => {
    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2', title: 'Two' })]
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(makePagedResult(sessions, 42))

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.total).toBe(42)
    expect(result.current.totalPages).toBe(5) // ceil(42/10) = 5
    expect(result.current.page).toBe(1)
    expect(result.current.error).toBeNull()
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, '')
  })

  // 2. setPage(2) triggers refetch with page 2
  it('triggers refetch when setPage(2) is called', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(makePagedResult([], 100))

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(2)
    })

    await waitFor(() => {
      expect(tauri.dailyChatListSessionsPaged).toHaveBeenLastCalledWith(2, '')
    })
    expect(result.current.page).toBe(2)
  })

  // 3. deleteSession calls IPC and invalidates
  it('deleteSession calls IPC and invalidates the list', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged)
      .mockResolvedValueOnce(makePagedResult([makeSession({ id: 's1' })], 1))
      .mockResolvedValue(makePagedResult([], 0))

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    await act(async () => {
      await result.current.deleteSession('s1')
    })

    expect(tauri.dailyChatDeleteSession).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(result.current.sessions).toHaveLength(0))
  })

  // 5. renameSession calls IPC and invalidates
  it('renameSession calls IPC and invalidates the list', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged)
      .mockResolvedValueOnce(makePagedResult([makeSession({ id: 's1', title: 'Old' })], 1))
      .mockResolvedValue(makePagedResult([makeSession({ id: 's1', title: 'New name' })], 1))

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    await act(async () => {
      await result.current.renameSession('s1', 'New name')
    })

    expect(tauri.dailyChatRenameSession).toHaveBeenCalledWith('s1', 'New name')
    await waitFor(() => expect(result.current.sessions[0].title).toBe('New name'))
  })

  // 5b. setPinned calls IPC and invalidates
  it('setPinned calls IPC and invalidates the list', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(
      makePagedResult([makeSession({ id: 's1' })], 1),
    )

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    await act(async () => {
      await result.current.setPinned('s1', true)
    })

    expect(tauri.dailyChatSetSessionPinned).toHaveBeenCalledWith('s1', true)
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
  })

  // 5c. Unpin is a separate argument path through the wrapper, not just the
  // `true` case negated — a `setPinned` that hardcoded `true` would still pass
  // the test above.
  it('setPinned forwards the unpin case and invalidates', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(
      makePagedResult([makeSession({ id: 's1', pinnedAt: 1_700_000_000 })]),
    )

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    await act(async () => {
      await result.current.setPinned('s1', false)
    })

    expect(tauri.dailyChatSetSessionPinned).toHaveBeenCalledWith('s1', false)
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
  })

  // 6. Page state written to tabStore under viewKey 'chat-sessions'
  it('writes the new page to tabStore under viewKey "chat-sessions"', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(makePagedResult([], 100))

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => {
      result.current.setPage(3)
    })

    await waitFor(() => {
      const { tabs, activeTabId } = useTabStore.getState()
      const tab = tabs.find((t) => t.id === activeTabId)
      expect(tab?.pagination?.['chat-sessions']).toBe(3)
    })
  })

  // 7b. post-sync chats-changed fan-out invalidates the list
  it('refetches when memlore:chats-changed fires (sync pull landed)', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged)
      .mockResolvedValueOnce(makePagedResult([], 0))
      .mockResolvedValue(makePagedResult([makeSession({ id: 'peer-1', title: 'From peer' })], 1))

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.sessions).toHaveLength(0)
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    await act(async () => {
      window.dispatchEvent(new CustomEvent('memlore:chats-changed'))
    })

    await waitFor(() => {
      expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalled()
    })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.sessions[0].id).toBe('peer-1')
  })

  // 7. ai:daily-chat-title-updated event invalidates and marks the row
  it('refreshes list and marks recentlyUpdatedTitleId on title-update event', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged)
      .mockResolvedValueOnce(makePagedResult([makeSession({ id: 's1', title: null })], 1))
      .mockResolvedValue(
        makePagedResult([makeSession({ id: 's1', title: 'A rough day at work' })], 1),
      )

    const { result } = renderHook(() => useDailyChatSessions())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(handlers['ai:daily-chat-title-updated']).toBeDefined()

    await act(async () => {
      emit('ai:daily-chat-title-updated', { sessionId: 's1', title: 'A rough day at work' })
    })

    await waitFor(() => expect(result.current.recentlyUpdatedTitleId).toBe('s1'))
    await waitFor(() => expect(result.current.sessions[0].title).toBe('A rough day at work'))

    // Highlight auto-clears after the 1.2s window.
    await waitFor(() => expect(result.current.recentlyUpdatedTitleId).toBeNull(), {
      timeout: 2000,
    })
  })

  it('fetches the persisted search query on remount instead of the unfiltered page', async () => {
    useChatComposerAttachmentsStore.setState({ searchQuery: '  Đà Nẵng  ' })

    renderHook(() => useDailyChatSessions())
    await waitFor(() => {
      expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, 'Đà Nẵng')
    })
  })

  it('trims and debounces the search query for 300 ms', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDailyChatSessions())
    await act(async () => {})
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    act(() => {
      result.current.setSearchQuery('  Đà Nẵng  ')
    })
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(tauri.dailyChatListSessionsPaged).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, 'Đà Nẵng')
  })

  it('settles rapid search changes with one fetch for the latest query', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDailyChatSessions())
    await act(async () => {})
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    act(() => {
      result.current.setSearchQuery('m')
      vi.advanceTimersByTime(100)
      result.current.setSearchQuery('mo')
      vi.advanceTimersByTime(100)
      result.current.setSearchQuery('morning')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, 'morning')
  })

  it('resets from a later page before fetching a changed search', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDailyChatSessions())
    await act(async () => {})

    act(() => {
      result.current.setPage(3)
    })
    await act(async () => {})
    expect(result.current.page).toBe(3)
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    act(() => {
      result.current.setSearchQuery('needle')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.page).toBe(1)
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, 'needle')
  })

  it('clears back to the unfiltered query', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDailyChatSessions())
    await act(async () => {})

    act(() => {
      result.current.setSearchQuery('needle')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    act(() => {
      result.current.setSearchQuery('   ')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, '')
  })

  it('mutation invalidation reuses the active settled query', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDailyChatSessions())
    await act(async () => {})

    act(() => {
      result.current.setSearchQuery('needle')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    vi.mocked(tauri.dailyChatListSessionsPaged).mockClear()

    await act(async () => {
      await result.current.renameSession('s1', 'Needle renamed')
    })

    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledOnce()
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledWith(1, 'needle')
  })

  it('updates the cached title before a filtered rename refetch returns empty', async () => {
    vi.useFakeTimers()
    const cached = makeSession({ id: 's1', title: 'Needle' })
    useChatSessionStore.setState({ chatSessionsById: { s1: cached } })
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(makePagedResult([]))

    const { result } = renderHook(() => useDailyChatSessions())
    await act(async () => {})
    act(() => {
      result.current.setSearchQuery('needle')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    await act(async () => {
      await result.current.renameSession('s1', 'Haystack')
    })

    expect(useChatSessionStore.getState().chatSessionsById.s1.title).toBe('Haystack')
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenLastCalledWith(1, 'needle')
  })

  it('updates the cached title from an AI title event before an empty filtered refetch', async () => {
    vi.useFakeTimers()
    const cached = makeSession({ id: 's1', title: 'Old generated title' })
    useChatSessionStore.setState({ chatSessionsById: { s1: cached } })
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue(makePagedResult([]))

    renderHook(() => useDailyChatSessions())
    await act(async () => {})
    expect(handlers['ai:daily-chat-title-updated']).toBeDefined()

    await act(async () => {
      emit('ai:daily-chat-title-updated', {
        sessionId: 's1',
        title: 'Fresh generated title',
      })
    })

    expect(useChatSessionStore.getState().chatSessionsById.s1.title).toBe('Fresh generated title')
  })
})
