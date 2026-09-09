import { create } from 'zustand'

/**
 * Transient hand-off queue for pre-attaching an entry to a freshly created
 * Daily Chat draft conversation.
 *
 * Crosses a view boundary: the entry card (Entries view) right-clicks
 * "AI → Start a chat", mints a draft session id, enqueues the source entry
 * against that id, and navigates to the Chat view. `ChatConversation` is
 * keyed by session id and owns its `attachments` in local state, so without
 * this queue there would be no way to seed the attachment from outside.
 *
 * Mirrors the shape of `chatDraftStore.pendingByEntryId` /
 * `templateStore.pendingByEntryId` — the established cross-view hand-off
 * pattern. Not persisted: an orphaned entry (user navigates away before the
 * draft mounts) is harmless and drops on app restart.
 */
interface ChatPendingAttachmentsState {
  pendingBySessionId: Record<string, { entryId: string }>

  enqueue: (sessionId: string, entryId: string) => void
  /** Returns the queued entry for the session id, or `null` if none.
   *  Returns `null` (not `undefined`) so consumers can mirror React state
   *  shape (`… | null`) without coalescing. Removing on read means a draft
   *  session mounts with its pre-attachment exactly once. */
  consume: (sessionId: string) => { entryId: string } | null
}

export const useChatPendingAttachmentsStore = create<ChatPendingAttachmentsState>()((set, get) => ({
  pendingBySessionId: {},

  enqueue: (sessionId, entryId) =>
    set((s) => ({
      pendingBySessionId: { ...s.pendingBySessionId, [sessionId]: { entryId } },
    })),

  consume: (sessionId) => {
    const pending = get().pendingBySessionId[sessionId]
    if (pending === undefined) return null
    set((s) => {
      const next = { ...s.pendingBySessionId }
      delete next[sessionId]
      return { pendingBySessionId: next }
    })
    return pending
  },
}))
