import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { usePagedQuery } from './usePagedQuery'
import {
  dailyChatDeleteSession,
  dailyChatListSessionsPaged,
  dailyChatRenameSession,
  dailyChatSetSessionPinned,
} from '../lib/tauri'
import { useChatComposerAttachmentsStore } from '../stores/chatComposerAttachmentsStore'
import { useChatSessionStore } from '../stores/chatSessionStore'
import type { ChatSessionMeta } from '../types/ai'

function updateCachedSessionTitle(sessionId: string, title: string) {
  const store = useChatSessionStore.getState()
  const cached = store.chatSessionsById[sessionId]
  if (!cached) return
  store.mergeSessions([{ ...cached, title }])
}

/**
 * Manage the list of persisted Daily Chat sessions.
 *
 * Returns the paged session list via `usePagedQuery` (viewKey `'chat-sessions'`),
 * CRUD mutation wrappers, and the `recentlyUpdatedTitleId` for the backend's
 * async title-gen flash animation.
 */
export function useDailyChatSessions() {
  const searchQuery = useChatComposerAttachmentsStore((s) => s.searchQuery)
  const setSearchQuery = useChatComposerAttachmentsStore((s) => s.setSearchQuery)
  const [settledQuery, setSettledQuery] = useState(() =>
    useChatComposerAttachmentsStore.getState().getSearchQuery().trim(),
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSettledQuery(searchQuery.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [searchQuery])

  const fetcher = useCallback(
    (page: number) => dailyChatListSessionsPaged(page, settledQuery),
    [settledQuery],
  )
  const paged = usePagedQuery<ChatSessionMeta>({
    viewKey: 'chat-sessions',
    fetcher,
    fingerprint: settledQuery,
    pageSize: 10,
  })

  const mergeSessions = useChatSessionStore((s) => s.mergeSessions)
  const removeSessionFromStore = useChatSessionStore((s) => s.removeSession)

  /** Last session whose title was updated by the backend's async
   *  title-gen — consumers (the list view) can flash the row briefly. */
  const [recentlyUpdatedTitleId, setRecentlyUpdatedTitleId] = useState<string | null>(null)

  // Mirror the paged list into the global `chatSessionsById` map so consumers
  // outside this subtree (notably tab titles in `TitleBar`) can resolve a
  // session's title by id. Catches every refetch path — initial load, page
  // change, title-update event, turn-complete refetch, lock/unlock invalidate.
  useEffect(() => {
    mergeSessions(paged.items)
  }, [paged.items, mergeSessions])

  // Keep a stable ref to `invalidate` so the event listener closure doesn't
  // capture a stale version when the component re-renders.
  const invalidateRef = useRef(paged.invalidate)
  invalidateRef.current = paged.invalidate

  // Listen for backend-emitted title updates.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    let cancelled = false
    void (async () => {
      const u = await listen<{ sessionId: string; title: string }>(
        'ai:daily-chat-title-updated',
        (e) => {
          if (cancelled) return
          updateCachedSessionTitle(e.payload.sessionId, e.payload.title)
          setRecentlyUpdatedTitleId(e.payload.sessionId)
          // Clear the highlight after ~1.2s (UI flash window).
          window.setTimeout(() => {
            setRecentlyUpdatedTitleId((curr) => (curr === e.payload.sessionId ? null : curr))
          }, 1200)
          void invalidateRef.current()
        },
      )
      if (cancelled) {
        u()
        return
      }
      unlisten = u
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, []) // effect does not depend on invalidate directly — uses ref

  // Refetch when a turn finishes or is cancelled, so the sticky `usedRag`
  // privacy indicator can appear on the session it belongs to.
  //
  // Nothing else refreshes it: `ai:daily-chat-title-updated` fires only on a
  // session's FIRST user turn, and the backend deliberately does not bump
  // `updated_at` when it flips `used_rag` (that would reshuffle the list on
  // every RAG turn), so no ordering-driven refetch picks it up either. Without
  // this the badge silently lags reality on every turn after the first.
  //
  // `cancelled` matters as much as `complete`: a cancelled turn has already
  // egressed entry content to the provider, and its assistant placeholder is
  // dropped — so the session-list badge is the ONLY disclosure surface left
  // for it.
  useEffect(() => {
    let unlisteners: UnlistenFn[] = []
    let cancelled = false
    void (async () => {
      const us = await Promise.all(
        (['ai:daily-chat-complete', 'ai:daily-chat-cancelled'] as const).map((event) =>
          listen(event, () => {
            if (cancelled) return
            void invalidateRef.current()
          }),
        ),
      )
      if (cancelled) {
        us.forEach((u) => u())
        return
      }
      unlisteners = us
    })()
    return () => {
      cancelled = true
      unlisteners.forEach((u) => u())
    }
  }, [])

  // After cloud pull (or mid-sync fan-out), chats.bin rows land in SQLite but
  // this hook would otherwise keep its paged snapshot until remount. Same
  // event channel entries/journals/tags/media already use via syncStore.
  useEffect(() => {
    const onChatsChanged = () => {
      void invalidateRef.current()
    }
    window.addEventListener('memlore:chats-changed', onChatsChanged)
    return () => window.removeEventListener('memlore:chats-changed', onChatsChanged)
  }, [])

  const deleteSession = useCallback(
    async (sessionId: string): Promise<void> => {
      await dailyChatDeleteSession(sessionId)
      removeSessionFromStore(sessionId)
      await paged.invalidate()
    },
    [paged, removeSessionFromStore],
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<void> => {
      await dailyChatRenameSession(sessionId, title)
      updateCachedSessionTitle(sessionId, title.trim())
      await paged.invalidate()
    },
    [paged],
  )

  const setPinned = useCallback(
    async (sessionId: string, pinned: boolean): Promise<void> => {
      await dailyChatSetSessionPinned(sessionId, pinned)
      // No optimistic mirror into `chatSessionStore`, deliberately — unlike
      // `renameSession`, which needs one because `TitleBar` resolves tab titles
      // out of that map and a filtered refetch can drop the row before it sees
      // the new title.
      //
      // The constraint this rests on, for whoever builds the pin menu: read
      // `pinnedAt` off `sessions` (= `paged.items`, owned by `usePagedQuery`),
      // NOT out of `chatSessionStore`. The refetch below is then what flips the
      // label. Read it from the store instead and you reintroduce the need for
      // an eager write here.
      await paged.invalidate()
    },
    [paged],
  )

  return {
    sessions: paged.items,
    total: paged.total,
    totalPages: paged.totalPages,
    page: paged.page,
    setPage: paged.setPage,
    isLoading: paged.isLoading,
    error: paged.error,
    invalidate: paged.invalidate,
    searchQuery,
    setSearchQuery,
    deleteSession,
    renameSession,
    setPinned,
    recentlyUpdatedTitleId,
  }
}
