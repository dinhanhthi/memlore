import { beforeEach, describe, expect, it } from 'vitest'

import { useChatPendingAttachmentsStore } from './chatPendingAttachmentsStore'

beforeEach(() => {
  useChatPendingAttachmentsStore.setState({ pendingBySessionId: {} })
})

describe('chatPendingAttachmentsStore', () => {
  it('returns null when no entry is queued for the session', () => {
    expect(useChatPendingAttachmentsStore.getState().consume('sess-1')).toBeNull()
  })

  it('returns the queued entry on the first consume', () => {
    useChatPendingAttachmentsStore.getState().enqueue('sess-1', 'entry-9')

    expect(useChatPendingAttachmentsStore.getState().consume('sess-1')).toEqual({
      entryId: 'entry-9',
    })
  })

  it('removes the entry on consume so a second consume returns null', () => {
    useChatPendingAttachmentsStore.getState().enqueue('sess-1', 'entry-9')
    useChatPendingAttachmentsStore.getState().consume('sess-1')

    expect(useChatPendingAttachmentsStore.getState().consume('sess-1')).toBeNull()
  })

  it('keeps other sessions untouched when one is consumed', () => {
    useChatPendingAttachmentsStore.getState().enqueue('sess-1', 'entry-1')
    useChatPendingAttachmentsStore.getState().enqueue('sess-2', 'entry-2')

    useChatPendingAttachmentsStore.getState().consume('sess-1')

    expect(useChatPendingAttachmentsStore.getState().consume('sess-2')).toEqual({
      entryId: 'entry-2',
    })
  })

  it('overwrites a queued entry when enqueue is called twice for the same session', () => {
    useChatPendingAttachmentsStore.getState().enqueue('sess-1', 'entry-1')
    useChatPendingAttachmentsStore.getState().enqueue('sess-1', 'entry-2')

    expect(useChatPendingAttachmentsStore.getState().consume('sess-1')).toEqual({
      entryId: 'entry-2',
    })
  })
})
