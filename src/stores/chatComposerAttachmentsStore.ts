import { create } from 'zustand'

import type { ChatAttachment } from '../types/ai'

/** Merge a consume-effect entry chip into a list already restored or
 *  user-edited while `getEntry` was in flight. Skip if that entry is
 *  already present; never replace the whole list. */
export function mergeConsumedEntryChip(
  prev: ChatAttachment[],
  chip: Extract<ChatAttachment, { kind: 'entry' }>,
): ChatAttachment[] {
  if (prev.some((a) => a.kind === 'entry' && a.id === chip.id)) return prev
  return [...prev, chip]
}

/**
 * In-memory Daily Chat composer attachments and session-list search query.
 *
 * `ChatConversation` remounts when `DailyChatView` unmounts (view/tab switch),
 * so chips live here as the write-through — same pattern as
 * `chatComposerDraftStore`. The session-list search box in
 * `useDailyChatSessions` uses the same slot so a remount keeps the query.
 * Not persisted: unsent journal attachments and list filters must not land
 * in localStorage / `memlore-tabs`.
 */
interface ChatComposerAttachmentsState {
  attachmentsBySessionId: Record<string, ChatAttachment[]>
  searchQuery: string

  setAttachments: (sessionId: string, attachments: ChatAttachment[]) => void
  getAttachments: (sessionId: string) => ChatAttachment[]
  clearAttachments: (sessionId: string) => void
  setSearchQuery: (query: string) => void
  getSearchQuery: () => string
  clearAll: () => void
}

export const useChatComposerAttachmentsStore = create<ChatComposerAttachmentsState>()(
  (set, get) => ({
    attachmentsBySessionId: {},
    searchQuery: '',

    setAttachments: (sessionId, attachments) => {
      if (attachments.length === 0) {
        get().clearAttachments(sessionId)
        return
      }
      set((s) => ({
        attachmentsBySessionId: { ...s.attachmentsBySessionId, [sessionId]: attachments },
      }))
    },

    getAttachments: (sessionId) => get().attachmentsBySessionId[sessionId] ?? [],

    clearAttachments: (sessionId) =>
      set((s) => {
        if (!(sessionId in s.attachmentsBySessionId)) return s
        const next = { ...s.attachmentsBySessionId }
        delete next[sessionId]
        return { attachmentsBySessionId: next }
      }),

    setSearchQuery: (query) => set({ searchQuery: query }),

    getSearchQuery: () => get().searchQuery,

    clearAll: () => set({ attachmentsBySessionId: {}, searchQuery: '' }),
  }),
)
