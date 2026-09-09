import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInlineMediaDeletionTracker,
  emitEntryDocSaved,
  ENTRY_DOC_SAVED_EVENT,
  type InlineMediaDeletionTracker,
} from './inlineMediaDeletionTracker'

function ids(...v: string[]): Set<string> {
  return new Set(v)
}

describe('createInlineMediaDeletionTracker', () => {
  let deleteMedia: ReturnType<typeof vi.fn>
  let onDeleted: ReturnType<typeof vi.fn>
  let tracker: InlineMediaDeletionTracker

  beforeEach(() => {
    deleteMedia = vi.fn().mockResolvedValue(undefined)
    onDeleted = vi.fn()
    tracker = createInlineMediaDeletionTracker({
      deleteMedia: deleteMedia as unknown as (id: string) => Promise<void>,
      onDeleted: onDeleted as unknown as () => void,
    })
  })

  afterEach(() => {
    tracker.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not delete on observe-remove alone (waits for a saved event)', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('deletes a media whose node was removed and then the entry was saved', async () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
    await Promise.resolve()
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('deletes only ids pending for the saved entry', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    tracker.observe('e2', ids('b'))
    tracker.observe('e2', ids())
    emitEntryDocSaved('e1')
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('deletes pending ids for an entry only once', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    emitEntryDocSaved('e1')
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('cancels the deletion when the node reappears (undo) before save', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    tracker.observe('e1', ids('a'))
    emitEntryDocSaved('e1')
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('never deletes a media that was never in the doc (save-bug orphan)', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids('a'))
    emitEntryDocSaved('e1')
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('does not delete a node that merely stays present', () => {
    tracker.observe('e1', ids('a', 'b'))
    tracker.observe('e1', ids('a', 'b'))
    emitEntryDocSaved('e1')
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('cancelPending stops a scheduled deletion', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    tracker.cancelPending('a')
    emitEntryDocSaved('e1')
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('resetBaseline prevents a new/empty doc from deleting the old entry media', () => {
    tracker.observe('e1', ids('a'))
    tracker.resetBaseline()
    tracker.observe('e2', ids())
    emitEntryDocSaved('e1')
    emitEntryDocSaved('e2')
    expect(deleteMedia).not.toHaveBeenCalled()
  })

  it('drains pending for the previous entry after resetBaseline (unmount / switch)', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    tracker.resetBaseline()
    tracker.observe('e2', ids('b'))
    emitEntryDocSaved('e1')
    expect(deleteMedia).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('swallows a "not found" rejection without logging (benign double-delete)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValueOnce('Media not found: a')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })

  it('retries a transient failure and succeeds on the retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValueOnce('database is locked')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    await Promise.resolve()
    await Promise.resolve()
    expect(deleteMedia).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(2)
    expect(onDeleted).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('gives up after maxRetries and stops calling deleteMedia', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValue('database is locked')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('cancels a re-inserted node during the retry window', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    deleteMedia.mockRejectedValueOnce('database is locked')
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    emitEntryDocSaved('e1')
    await Promise.resolve()
    await Promise.resolve()
    tracker.observe('e1', ids('a'))
    await vi.advanceTimersByTimeAsync(50)
    expect(deleteMedia).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('ignores a saved event with no entryId', () => {
    tracker.observe('e1', ids('a'))
    tracker.observe('e1', ids())
    window.dispatchEvent(new CustomEvent(ENTRY_DOC_SAVED_EVENT, { detail: {} }))
    expect(deleteMedia).not.toHaveBeenCalled()
  })
})
