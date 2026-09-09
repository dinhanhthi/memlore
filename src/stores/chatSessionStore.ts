import { create } from 'zustand'
import type { ChatSessionMeta } from '../types/ai'

interface ChatSessionState {
  /**
   * Lookup map of Daily Chat sessions the app has seen this session, keyed
   * by id. Mirrors the `entriesById` pattern in `entryStore.ts`.
   *
   * The paged session list lives in the `useDailyChatSessions` hook (local
   * to `DailyChatView`), so consumers outside that subtree — notably tab
   * titles in `TitleBar` — have no way to resolve a session's title by id.
   * This map is populated as the paged list loads/refreshes, giving those
   * consumers a global lookup without a new Tauri command.
   *
   * Not persisted: sessions re-load from the DB on app open, and we never
   * want a stale title to override a fresh DB read.
   *
   * Growth: this map accumulates as the user pages through history and is
   * only pruned on explicit delete — it is not bounded. Accepted because
   * each `ChatSessionMeta` is small (8 fields) and the map is cleared on
   * process restart. If a heavy daily-chat user ever makes this matter,
   * cap it (e.g. keep the most-recent N by `updatedAt`).
   */
  chatSessionsById: Record<string, ChatSessionMeta>

  /** Merge sessions into `chatSessionsById` (upsert by id). */
  mergeSessions: (sessions: ChatSessionMeta[]) => void
  /** Remove a session from `chatSessionsById` by id. */
  removeSession: (id: string) => void
}

function indexBy(sessions: ChatSessionMeta[]): Record<string, ChatSessionMeta> {
  const out: Record<string, ChatSessionMeta> = {}
  for (const s of sessions) out[s.id] = s
  return out
}

export const useChatSessionStore = create<ChatSessionState>()((set) => ({
  chatSessionsById: {},

  mergeSessions: (sessions) =>
    set((state) => ({
      chatSessionsById: { ...state.chatSessionsById, ...indexBy(sessions) },
    })),

  removeSession: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.chatSessionsById
      return { chatSessionsById: rest }
    }),
}))
