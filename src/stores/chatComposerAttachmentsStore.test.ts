import { beforeEach, describe, expect, it } from 'vitest'

import type { ChatAttachment } from '../types/ai'
import {
  mergeConsumedEntryChip,
  useChatComposerAttachmentsStore,
} from './chatComposerAttachmentsStore'

const entryChip: ChatAttachment = {
  kind: 'entry',
  id: 'ent-1',
  title: 'Morning',
  entryDate: 1_700_000_000,
}

const periodChip: ChatAttachment = {
  kind: 'period',
  start: 1_700_000_000,
  end: 1_700_086_400,
  label: 'Last week',
  entryCount: 3,
}

beforeEach(() => {
  useChatComposerAttachmentsStore.setState({ attachmentsBySessionId: {}, searchQuery: '' })
})

describe('chatComposerAttachmentsStore', () => {
  it('returns an empty list when no attachments exist for the session', () => {
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([])
  })

  it('stores and returns attachments for a session', () => {
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [entryChip])

    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([entryChip])
  })

  it('deletes the key when setAttachments is called with an empty list', () => {
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [entryChip])
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [])

    expect(useChatComposerAttachmentsStore.getState().attachmentsBySessionId).not.toHaveProperty(
      'sess-1',
    )
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([])
  })

  it('keeps other sessions untouched when one session is set', () => {
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [entryChip])
    useChatComposerAttachmentsStore.getState().setAttachments('sess-2', [periodChip])

    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([entryChip])
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-2')).toEqual([
      periodChip,
    ])
  })

  it('overwrites an existing list for the same session', () => {
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [entryChip])
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [periodChip])

    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([
      periodChip,
    ])
  })

  it('clears only the requested session', () => {
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [entryChip])
    useChatComposerAttachmentsStore.getState().setAttachments('sess-2', [periodChip])
    useChatComposerAttachmentsStore.getState().clearAttachments('sess-1')

    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([])
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-2')).toEqual([
      periodChip,
    ])
  })

  it('returns an empty string when no search query has been set', () => {
    expect(useChatComposerAttachmentsStore.getState().getSearchQuery()).toBe('')
  })

  it('stores and returns the session-list search query', () => {
    useChatComposerAttachmentsStore.getState().setSearchQuery('morning')

    expect(useChatComposerAttachmentsStore.getState().getSearchQuery()).toBe('morning')
  })

  it('overwrites the search query', () => {
    useChatComposerAttachmentsStore.getState().setSearchQuery('first')
    useChatComposerAttachmentsStore.getState().setSearchQuery('second')

    expect(useChatComposerAttachmentsStore.getState().getSearchQuery()).toBe('second')
  })

  it('clearAll removes every attachment list and the search query', () => {
    useChatComposerAttachmentsStore.getState().setAttachments('sess-1', [entryChip])
    useChatComposerAttachmentsStore.getState().setAttachments('sess-2', [periodChip])
    useChatComposerAttachmentsStore.getState().setSearchQuery('morning')
    useChatComposerAttachmentsStore.getState().clearAll()

    expect(useChatComposerAttachmentsStore.getState().attachmentsBySessionId).toEqual({})
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([])
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-2')).toEqual([])
    expect(useChatComposerAttachmentsStore.getState().getSearchQuery()).toBe('')
  })
})

describe('mergeConsumedEntryChip', () => {
  it('appends the consumed entry when the list is empty', () => {
    expect(mergeConsumedEntryChip([], entryChip)).toEqual([entryChip])
  })

  it('keeps an existing period chip and appends the consumed entry', () => {
    expect(mergeConsumedEntryChip([periodChip], entryChip)).toEqual([periodChip, entryChip])
  })

  it('skips when the consumed entry is already present', () => {
    expect(mergeConsumedEntryChip([entryChip, periodChip], entryChip)).toEqual([
      entryChip,
      periodChip,
    ])
  })
})
