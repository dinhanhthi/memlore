import { describe, expect, it, beforeEach } from 'vitest'
import { useChatDraftStore } from './chatDraftStore'

describe('chatDraftStore', () => {
  beforeEach(() => {
    useChatDraftStore.setState({ pendingByEntryId: {}, pendingAppendByEntryId: {} })
  })

  it('starts empty', () => {
    expect(useChatDraftStore.getState().pendingByEntryId).toEqual({})
  })

  it('enqueues an HTML draft for an entry id', () => {
    useChatDraftStore.getState().enqueuePendingChatDraft('entry-1', '<p>hi</p>')
    expect(useChatDraftStore.getState().pendingByEntryId).toEqual({ 'entry-1': '<p>hi</p>' })
  })

  it('returns and removes the queued draft on consume', () => {
    useChatDraftStore.getState().enqueuePendingChatDraft('entry-1', '<p>hi</p>')
    const drained = useChatDraftStore.getState().consumePendingChatDraft('entry-1')
    expect(drained).toBe('<p>hi</p>')
    expect(useChatDraftStore.getState().pendingByEntryId).toEqual({})
  })

  it('returns null when nothing is queued for the id', () => {
    expect(useChatDraftStore.getState().consumePendingChatDraft('missing')).toBeNull()
  })

  it('keeps drafts for unrelated entry ids when one is consumed', () => {
    useChatDraftStore.getState().enqueuePendingChatDraft('a', '<p>A</p>')
    useChatDraftStore.getState().enqueuePendingChatDraft('b', '<p>B</p>')
    useChatDraftStore.getState().consumePendingChatDraft('a')
    expect(useChatDraftStore.getState().pendingByEntryId).toEqual({ b: '<p>B</p>' })
  })

  describe('pendingAppendByEntryId', () => {
    it('enqueues an append and returns { id, html } on consume', () => {
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>x</p>')
      const drained = useChatDraftStore.getState().consumePendingChatAppend('e1')
      expect(drained).not.toBeNull()
      expect(typeof drained?.id).toBe('string')
      expect(drained?.id).toBeTruthy()
      expect(drained?.html).toBe('<p>x</p>')
    })

    it('returns null on a second consume after the first drains the queue', () => {
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>x</p>')
      useChatDraftStore.getState().consumePendingChatAppend('e1')
      expect(useChatDraftStore.getState().consumePendingChatAppend('e1')).toBeNull()
    })

    it('returns null when nothing is queued for the id', () => {
      expect(useChatDraftStore.getState().consumePendingChatAppend('nonexistent')).toBeNull()
    })

    it('overwrites on a second enqueue to the same entryId with fresh html AND a fresh id', () => {
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>first</p>')
      const first = useChatDraftStore.getState().consumePendingChatAppend('e1')
      expect(first?.html).toBe('<p>first</p>')

      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>second</p>')
      const second = useChatDraftStore.getState().consumePendingChatAppend('e1')

      expect(second?.html).toBe('<p>second</p>')
      expect(second?.id).not.toBe(first?.id)
      expect(typeof second?.id).toBe('string')
    })

    it('mints a new id on every enqueue', () => {
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>a</p>')
      const beforeConsume = useChatDraftStore.getState().pendingAppendByEntryId['e1']?.id

      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>b</p>')
      const afterReenqueue = useChatDraftStore.getState().pendingAppendByEntryId['e1']?.id

      expect(afterReenqueue).not.toBe(beforeConsume)
    })

    it('is independent of pendingByEntryId (enqueueing an append does not touch it)', () => {
      useChatDraftStore.getState().enqueuePendingChatDraft('e1', '<p>seed</p>')
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>delta</p>')

      expect(useChatDraftStore.getState().pendingByEntryId).toEqual({ e1: '<p>seed</p>' })
      expect(useChatDraftStore.getState().pendingAppendByEntryId['e1']?.html).toBe('<p>delta</p>')
    })

    it('is independent of pendingByEntryId (enqueueing a seed does not touch append)', () => {
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>delta</p>')
      useChatDraftStore.getState().enqueuePendingChatDraft('e1', '<p>seed</p>')

      expect(useChatDraftStore.getState().pendingAppendByEntryId['e1']?.html).toBe('<p>delta</p>')
      expect(useChatDraftStore.getState().pendingByEntryId).toEqual({ e1: '<p>seed</p>' })
    })

    it('consuming the append does not drain pendingByEntryId', () => {
      useChatDraftStore.getState().enqueuePendingChatDraft('e1', '<p>seed</p>')
      useChatDraftStore.getState().enqueuePendingChatAppend('e1', '<p>delta</p>')

      useChatDraftStore.getState().consumePendingChatAppend('e1')

      expect(useChatDraftStore.getState().pendingByEntryId).toEqual({ e1: '<p>seed</p>' })
      expect(useChatDraftStore.getState().pendingAppendByEntryId).toEqual({})
    })

    it('consumes and removes only the targeted entry id', () => {
      useChatDraftStore.getState().enqueuePendingChatAppend('a', '<p>A</p>')
      useChatDraftStore.getState().enqueuePendingChatAppend('b', '<p>B</p>')

      const drained = useChatDraftStore.getState().consumePendingChatAppend('a')
      expect(drained?.html).toBe('<p>A</p>')

      const remaining = useChatDraftStore.getState().pendingAppendByEntryId
      expect(Object.keys(remaining)).toEqual(['b'])
      expect(remaining['b']?.html).toBe('<p>B</p>')
    })
  })
})
