/**
 * Tracks inline media nodes that disappear from the editor doc (Backspace, cut,
 * delete, explicit remove) and deletes their backing media (DB row + disk file)
 * only after that entry's Yjs doc has been durably saved.
 *
 * Design notes:
 * - Only ids that were SEEN in the doc and then disappeared are deleted. A DB
 *   row that was never in the doc (a "save-bug orphan") never enters the
 *   baseline, so it is never deleted here — it keeps its recovery banner.
 * - Deletion waits for `memlore:entry-doc-saved` for the same entryId, and
 *   re-checks the latest observed ids at drain time so an undo/redo re-insert
 *   before save cancels it. Attached media (footer strip, never in the doc)
 *   are never tracked, so they are untouched.
 * - The cloud copy is not deleted here; the sync engine's own-cloud media prune
 *   sweeps a blob once its local row is gone.
 */

// TODO(later): undo after save still leaves a broken node — see docs/LATER.md

export const ENTRY_DOC_SAVED_EVENT = 'memlore:entry-doc-saved'

export interface EntryDocSavedDetail {
  entryId: string
}

export function emitEntryDocSaved(entryId: string): void {
  window.dispatchEvent(
    new CustomEvent<EntryDocSavedDetail>(ENTRY_DOC_SAVED_EVENT, { detail: { entryId } }),
  )
}

export interface InlineMediaDeletionTracker {
  /** Call on every editor update with the media ids currently in the doc. */
  observe(entryId: string, currentIds: Set<string>): void
  /**
   * Reset the baseline (call when a new editor/doc is attached) so the next
   * `observe` seeds from the loaded doc without treating its ids as removals.
   * Does NOT cancel already-pending deletions.
   */
  resetBaseline(): void
  /**
   * Cancel a scheduled deletion — used when another path already deleted this
   * id, so the next saved-event drain does not fire a redundant delete.
   */
  cancelPending(id: string): void
  /** Remove the saved-event listener. Tests must call this; production does not. */
  dispose(): void
}

export interface InlineMediaDeletionOptions {
  deleteMedia: (id: string) => Promise<void>
  /** Invoked after a successful deletion (e.g. to refresh the attachment strip). */
  onDeleted?: () => void
  /**
   * How many times to retry a media whose delete failed transiently (e.g. a
   * `database is locked` / locked-app error), before giving up and logging.
   * A "not found" rejection is always treated as success (benign). Default 1.
   */
  maxRetries?: number
  /** Injectable target for tests; default `window`. */
  eventTarget?: EventTarget
}

export function createInlineMediaDeletionTracker(
  opts: InlineMediaDeletionOptions,
): InlineMediaDeletionTracker {
  const maxRetries = opts.maxRetries ?? 1
  const eventTarget = opts.eventTarget ?? window

  // Ids present in the doc on the previous observe (to diff removals against).
  let prevIds = new Set<string>()
  // Ids present in the doc on the MOST RECENT observe (the recheck at drain
  // time reads this so a re-insert after scheduling still wins).
  let lastIds = new Set<string>()
  // Observed-then-disappeared ids waiting for that entry's saved event.
  const pending = new Map<string, { entryId: string; attempt: number }>()

  const attemptDelete = (id: string, attempt: number) => {
    if (lastIds.has(id)) return
    void opts
      .deleteMedia(id)
      .then(() => {
        opts.onDeleted?.()
      })
      .catch((err: unknown) => {
        const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        if (/not found/i.test(msg)) return
        if (attempt < maxRetries) {
          console.warn(`[media] delete of removed inline media ${id} failed, retrying:`, err)
          setTimeout(() => attemptDelete(id, attempt + 1), 50)
        } else {
          console.warn(`[media] gave up deleting removed inline media ${id}:`, err)
        }
      })
  }

  const cancelPending: InlineMediaDeletionTracker['cancelPending'] = (id) => {
    pending.delete(id)
  }

  const drain = (entryId: string) => {
    for (const [id, p] of [...pending]) {
      if (p.entryId !== entryId) continue
      pending.delete(id)
      attemptDelete(id, p.attempt)
    }
  }

  const onSaved = (event: Event) => {
    const entryId = (event as CustomEvent<EntryDocSavedDetail>).detail?.entryId
    if (typeof entryId !== 'string' || entryId.length === 0) return
    drain(entryId)
  }

  eventTarget.addEventListener(ENTRY_DOC_SAVED_EVENT, onSaved)

  const observe: InlineMediaDeletionTracker['observe'] = (entryId, currentIds) => {
    lastIds = new Set(currentIds)
    for (const id of currentIds) cancelPending(id)
    for (const id of prevIds) {
      if (currentIds.has(id) || pending.has(id)) continue
      pending.set(id, { entryId, attempt: 0 })
    }
    prevIds = new Set(currentIds)
  }

  const resetBaseline: InlineMediaDeletionTracker['resetBaseline'] = () => {
    prevIds = new Set()
    lastIds = new Set()
  }

  const dispose: InlineMediaDeletionTracker['dispose'] = () => {
    eventTarget.removeEventListener(ENTRY_DOC_SAVED_EVENT, onSaved)
  }

  return { observe, resetBaseline, cancelPending, dispose }
}
