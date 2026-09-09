import { useEffect, useMemo, useState } from 'react'
import { chatSessionForEntry } from '../lib/tauri'

/** The chat session that produced an entry, if any. `null` title means the
 *  session has no title yet (e.g. AI title generation still pending). */
export interface ChatSessionRef {
  sessionId: string
  title: string | null
}

/**
 * Resolves the Daily Chat session that an entry was generated from (if any).
 *
 * A thin React wrapper over `chatSessionForEntry` — components must not call
 * `invoke` directly (project rule). Returns `{ sessionRef, loading }`:
 * - `sessionRef` is `null` while loading, when `entryId` is falsy, or when the
 *   backend reports no linked session (the entry was never a chat conversion).
 * - `loading` flips to `true` on each new `entryId` and back to `false` once
 *   the read settles.
 *
 * No error state is surfaced: `null` already means "no source chat", which is
 * the only thing a caller needs to distinguish.
 */
export function useChatSessionForEntry(entryId: string | null | undefined) {
  const [sessionRef, setSessionRef] = useState<ChatSessionRef | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!entryId) {
      setSessionRef(null)
      return
    }
    let cancelled = false
    setLoading(true)
    chatSessionForEntry(entryId)
      .then((ref) => {
        if (!cancelled) setSessionRef(ref)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [entryId])

  // Stable identity: callers that destructure into deps/memos must not see a
  // fresh object every render when neither value changed.
  return useMemo(() => ({ sessionRef, loading }), [sessionRef, loading])
}
