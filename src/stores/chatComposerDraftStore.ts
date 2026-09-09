import { create } from 'zustand'

/**
 * In-memory Daily Chat composer drafts, keyed by session id.
 *
 * `ChatConversation` holds the textarea in local state and remounts when
 * `DailyChatView` unmounts (view/tab switch). This store is the write-through
 * so unsent text survives remount. Not persisted: unsent journal text must
 * not land in localStorage / `memlore-tabs`.
 */
interface ChatComposerDraftState {
  draftsBySessionId: Record<string, string>

  setDraft: (sessionId: string, text: string) => void
  getDraft: (sessionId: string) => string
  clearDraft: (sessionId: string) => void
  clearAll: () => void
}

export const useChatComposerDraftStore = create<ChatComposerDraftState>()((set, get) => ({
  draftsBySessionId: {},

  setDraft: (sessionId, text) => {
    if (text === '') {
      get().clearDraft(sessionId)
      return
    }
    set((s) => ({ draftsBySessionId: { ...s.draftsBySessionId, [sessionId]: text } }))
  },

  getDraft: (sessionId) => get().draftsBySessionId[sessionId] ?? '',

  clearDraft: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.draftsBySessionId)) return s
      const next = { ...s.draftsBySessionId }
      delete next[sessionId]
      return { draftsBySessionId: next }
    }),

  clearAll: () => set({ draftsBySessionId: {} }),
}))
