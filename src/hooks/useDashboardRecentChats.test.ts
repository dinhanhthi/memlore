import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDashboardRecentChats } from './useDashboardRecentChats'
import type { ChatSession, ChatSessionMeta } from '../types/ai'
import type { PagedResult } from '../types/pagination'

vi.mock('../lib/tauri', () => ({
  dailyChatListSessionsPaged: vi.fn(),
  dailyChatLoadSession: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeMeta = (overrides: Partial<ChatSessionMeta> = {}): ChatSessionMeta => ({
  id: 's1',
  title: 'Session One',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  messageCount: 1,
  usedRag: false,
  pinnedAt: null,
  convertedEntryId: null,
  ...overrides,
})

const makeSession = (id: string, content: string): ChatSession => ({
  id,
  title: 'T',
  persona: 'empathetic',
  language: 'en',
  createdAt: 1,
  updatedAt: 2,
  messages: [{ id: `${id}-m`, role: 'user', content, seq: 1, createdAt: 1 }],
  convertedEntryId: null,
  convertedThroughSeq: null,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useDashboardRecentChats', () => {
  it('loads the 3 most recently updated sessions with excerpts', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue({
      items: [
        makeMeta({ id: 'old', updatedAt: 10, title: 'Old' }),
        makeMeta({ id: 'new', updatedAt: 30, title: 'New' }),
        makeMeta({ id: 'mid', updatedAt: 20, title: 'Mid' }),
        makeMeta({ id: 'older', updatedAt: 5, title: 'Older' }),
      ],
      total: 4,
    } satisfies PagedResult<ChatSessionMeta>)
    vi.mocked(tauri.dailyChatLoadSession).mockImplementation(async (id) =>
      makeSession(id, `excerpt for ${id}`),
    )

    const { result } = renderHook(() => useDashboardRecentChats(3))
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.chats.map((c) => c.id)).toEqual(['new', 'mid', 'old'])
    expect(result.current.chats[0]?.excerpt).toBe('excerpt for new')
    expect(tauri.dailyChatLoadSession).toHaveBeenCalledTimes(3)
  })

  it('collapses whitespace in excerpts', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue({
      items: [makeMeta({ id: 's1', updatedAt: 1 })],
      total: 1,
    })
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValue(makeSession('s1', 'hello\n\n  world'))

    const { result } = renderHook(() => useDashboardRecentChats())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.chats[0]?.excerpt).toBe('hello world')
  })

  it('refetches on memlore:chats-changed', async () => {
    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue({ items: [], total: 0 })

    const { result } = renderHook(() => useDashboardRecentChats())
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(tauri.dailyChatListSessionsPaged).toHaveBeenCalledTimes(1)

    vi.mocked(tauri.dailyChatListSessionsPaged).mockResolvedValue({
      items: [makeMeta({ id: 'fresh', updatedAt: 9, title: 'Fresh' })],
      total: 1,
    })
    vi.mocked(tauri.dailyChatLoadSession).mockResolvedValue(makeSession('fresh', 'hi'))

    act(() => {
      window.dispatchEvent(new Event('memlore:chats-changed'))
    })
    await waitFor(() => {
      expect(result.current.chats[0]?.id).toBe('fresh')
    })
  })
})
