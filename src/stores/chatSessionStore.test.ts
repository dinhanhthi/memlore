import { describe, expect, it, beforeEach } from 'vitest'
import { useChatSessionStore } from './chatSessionStore'
import type { ChatSessionMeta } from '../types/ai'

function meta(id: string, title: string | null): ChatSessionMeta {
  return {
    id,
    title,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    usedRag: false,
    pinnedAt: null,
    convertedEntryId: null,
  }
}

describe('chatSessionStore', () => {
  beforeEach(() => {
    useChatSessionStore.setState({ chatSessionsById: {} })
  })

  it('starts empty', () => {
    expect(useChatSessionStore.getState().chatSessionsById).toEqual({})
  })

  it('merges sessions into the map', () => {
    useChatSessionStore.getState().mergeSessions([meta('a', 'First'), meta('b', 'Second')])
    expect(useChatSessionStore.getState().chatSessionsById).toEqual({
      a: meta('a', 'First'),
      b: meta('b', 'Second'),
    })
  })

  it('upserts an existing session on re-merge (title refresh)', () => {
    useChatSessionStore.getState().mergeSessions([meta('a', 'Old title')])
    useChatSessionStore.getState().mergeSessions([meta('a', 'New title')])
    expect(useChatSessionStore.getState().chatSessionsById['a']).toEqual(meta('a', 'New title'))
  })

  it('keeps unrelated sessions when upserting one', () => {
    useChatSessionStore.getState().mergeSessions([meta('a', 'A'), meta('b', 'B')])
    useChatSessionStore.getState().mergeSessions([meta('a', 'A2')])
    expect(useChatSessionStore.getState().chatSessionsById).toEqual({
      a: meta('a', 'A2'),
      b: meta('b', 'B'),
    })
  })

  it('removes a session by id', () => {
    useChatSessionStore.getState().mergeSessions([meta('a', 'A'), meta('b', 'B')])
    useChatSessionStore.getState().removeSession('a')
    expect(useChatSessionStore.getState().chatSessionsById).toEqual({ b: meta('b', 'B') })
  })

  it('is a no-op to remove a missing id', () => {
    useChatSessionStore.getState().mergeSessions([meta('a', 'A')])
    useChatSessionStore.getState().removeSession('missing')
    expect(useChatSessionStore.getState().chatSessionsById).toEqual({ a: meta('a', 'A') })
  })
})
