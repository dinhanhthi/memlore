import { create } from 'zustand'
import { randomId } from '../lib/randomId'

interface PendingAppend {
  /** Fresh nonce minted on each enqueue. The editor subscription keys off
   *  this to re-apply when the same entryId is re-enqueued. */
  id: string
  html: string
}

interface ChatDraftState {
  /**
   * Transient queue of "seed this HTML into the editor for the freshly
   * created entry" handoffs. Set when the user accepts a "Save as
   * entry" draft from `ChatConversation`; cleared by the editor once
   * it mounts the entry and applies the content. Not persisted.
   *
   * Mirrors the shape of `templateStore.pendingByEntryId` — see
   * `EditorPanel.tsx` for the consuming pattern. The two queues are
   * mutually exclusive per entry id (a brand new entry comes from
   * exactly one source: TemplatePicker, Daily Chat, or Dashboard
   * "Write now").
   */
  pendingByEntryId: Record<string, string>

  enqueuePendingChatDraft: (entryId: string, html: string) => void
  /** Returns the queued HTML for the entry id, or `null` if none.
   *  Returns `null` (not `undefined`) so consumers can mirror the
   *  matching React state shape (`string | null`) without coalescing. */
  consumePendingChatDraft: (entryId: string) => string | null

  /**
   * Transient queue of "append this HTML delta into the editor for an
   * EXISTING entry" handoffs — the "Update the entry" flow. Separate
   * from `pendingByEntryId` (which seeds a fresh entry); the two serve
   * different purposes and are independent per entry id. Not persisted.
   *
   * Each enqueue stores `{ id, html }` under `entryId`, minting a fresh
   * nonce `id` so the editor subscription can detect a re-apply even
   * when the same entryId is enqueued repeatedly.
   */
  pendingAppendByEntryId: Record<string, PendingAppend>

  enqueuePendingChatAppend: (entryId: string, html: string) => void
  /** Returns the queued `{ id, html }` for the entry id and removes it,
   *  or `null` if none. Returns `null` (not `undefined`) so consumers
   *  can mirror the matching React state shape without coalescing. */
  consumePendingChatAppend: (entryId: string) => PendingAppend | null
}

export const useChatDraftStore = create<ChatDraftState>()((set, get) => ({
  pendingByEntryId: {},

  enqueuePendingChatDraft: (entryId, html) =>
    set((s) => ({
      pendingByEntryId: { ...s.pendingByEntryId, [entryId]: html },
    })),

  consumePendingChatDraft: (entryId) => {
    const pending = get().pendingByEntryId[entryId]
    if (pending === undefined) return null
    set((s) => {
      const next = { ...s.pendingByEntryId }
      delete next[entryId]
      return { pendingByEntryId: next }
    })
    return pending
  },

  pendingAppendByEntryId: {},

  enqueuePendingChatAppend: (entryId, html) =>
    set((s) => ({
      pendingAppendByEntryId: {
        ...s.pendingAppendByEntryId,
        [entryId]: { id: randomId(), html },
      },
    })),

  consumePendingChatAppend: (entryId) => {
    const pending = get().pendingAppendByEntryId[entryId]
    if (pending === undefined) return null
    set((s) => {
      const next = { ...s.pendingAppendByEntryId }
      delete next[entryId]
      return { pendingAppendByEntryId: next }
    })
    return pending
  },
}))
