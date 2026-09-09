import { beforeEach, describe, expect, it } from 'vitest'

import { useChatComposerDraftStore } from './chatComposerDraftStore'

beforeEach(() => {
  useChatComposerDraftStore.setState({ draftsBySessionId: {} })
})

describe('chatComposerDraftStore', () => {
  it('returns an empty string when no draft exists for the session', () => {
    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('')
  })

  it('stores and returns draft text for a session', () => {
    useChatComposerDraftStore.getState().setDraft('sess-1', 'hello')

    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('hello')
  })

  it('deletes the key when setDraft is called with an empty string', () => {
    useChatComposerDraftStore.getState().setDraft('sess-1', 'hello')
    useChatComposerDraftStore.getState().setDraft('sess-1', '')

    expect(useChatComposerDraftStore.getState().draftsBySessionId).not.toHaveProperty('sess-1')
    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('')
  })

  it('keeps other sessions untouched when one draft is set', () => {
    useChatComposerDraftStore.getState().setDraft('sess-1', 'one')
    useChatComposerDraftStore.getState().setDraft('sess-2', 'two')

    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('one')
    expect(useChatComposerDraftStore.getState().getDraft('sess-2')).toBe('two')
  })

  it('overwrites an existing draft for the same session', () => {
    useChatComposerDraftStore.getState().setDraft('sess-1', 'first')
    useChatComposerDraftStore.getState().setDraft('sess-1', 'second')

    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('second')
  })

  it('clears only the requested session', () => {
    useChatComposerDraftStore.getState().setDraft('sess-1', 'one')
    useChatComposerDraftStore.getState().setDraft('sess-2', 'two')
    useChatComposerDraftStore.getState().clearDraft('sess-1')

    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('')
    expect(useChatComposerDraftStore.getState().getDraft('sess-2')).toBe('two')
  })

  it('clearAll removes every draft', () => {
    useChatComposerDraftStore.getState().setDraft('sess-1', 'one')
    useChatComposerDraftStore.getState().setDraft('sess-2', 'two')
    useChatComposerDraftStore.getState().clearAll()

    expect(useChatComposerDraftStore.getState().draftsBySessionId).toEqual({})
    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('')
    expect(useChatComposerDraftStore.getState().getDraft('sess-2')).toBe('')
  })
})
