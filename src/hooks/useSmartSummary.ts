import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cancelSuggestion, suggestTitle } from '../lib/tauri'

/**
 * Streaming title-suggestion hook (Phase 6 v2 R6).
 *
 * The R1-era hook awaited a single `suggestTitle` round-trip and
 * resolved the final string. R6 replaces that with a streaming flow:
 *
 * 1. `suggest(entryId)` starts the backend stream and the hook
 *    listens to `ai:suggest-title-token` events keyed by entry id,
 *    accumulating the partial string into `partial`.
 * 2. On `ai:suggest-title-complete`, the hook flips to `kind: 'done'`
 *    with the assembled title. Caller decides whether to apply.
 * 3. On `ai:suggest-title-error`, flips to `kind: 'error'` with the
 *    backend error code (`AI_AUTH_FAILED`, etc.).
 * 4. On `ai:suggest-title-cancelled`, flips to `kind: 'cancelled'`.
 * 5. `cancel(entryId)` fires the backend's cancellation token and
 *    resets local state to `idle`.
 *
 * The hook scopes ALL events to the entry id captured at `suggest()`
 * time so a stale stream from a different entry can't update the
 * current pill.
 */
export type SuggestionState =
  | { kind: 'idle' }
  | { kind: 'streaming'; entryId: string; partial: string }
  | { kind: 'done'; entryId: string; title: string }
  | { kind: 'error'; entryId: string; code: string }
  | { kind: 'cancelled'; entryId: string }

interface SuggestTitleTokenEvent {
  entry_id: string
  delta: string
}
interface SuggestTitleCompleteEvent {
  entry_id: string
  title: string
}
interface SuggestTitleErrorEvent {
  entry_id: string
  /** Stable error code (R6 backend post-review fix). Pre-fix events
   *  without `code` fall back to the legacy `error` field's body. */
  code?: string
  message?: string
  error?: string
}
interface SuggestTitleCancelledEvent {
  entry_id: string
}

export function useSmartSummary() {
  const [state, setState] = useState<SuggestionState>({ kind: 'idle' })
  const activeEntryIdRef = useRef<string | null>(null)
  const unlistenersRef = useRef<UnlistenFn[]>([])

  function teardownListeners() {
    for (const u of unlistenersRef.current) u()
    unlistenersRef.current = []
  }

  // Tear down listeners on unmount.
  useEffect(() => {
    return () => {
      teardownListeners()
      // Best-effort: cancel any in-flight stream for this entry so
      // the backend doesn't keep streaming into a dropped channel.
      const id = activeEntryIdRef.current
      if (id) {
        void cancelSuggestion(id).catch(() => {})
      }
    }
  }, [])

  const suggest = useCallback(async (entryId: string) => {
    // Tear down any prior listeners (a re-click on the pill).
    teardownListeners()

    activeEntryIdRef.current = entryId
    setState({ kind: 'streaming', entryId, partial: '' })

    const filterByEntry = <T extends { entry_id: string }>(
      handler: (payload: T) => void,
    ): ((event: { payload: T }) => void) => {
      return (event) => {
        if (event.payload.entry_id !== entryId) return
        handler(event.payload)
      }
    }

    const tokenUnlisten = await listen<SuggestTitleTokenEvent>(
      'ai:suggest-title-token',
      filterByEntry<SuggestTitleTokenEvent>((p) => {
        setState((prev) =>
          prev.kind === 'streaming' && prev.entryId === entryId
            ? { ...prev, partial: prev.partial + p.delta }
            : prev,
        )
      }),
    )
    const completeUnlisten = await listen<SuggestTitleCompleteEvent>(
      'ai:suggest-title-complete',
      filterByEntry<SuggestTitleCompleteEvent>((p) => {
        // Guard: only transition from streaming. A late-arriving
        // complete after `reset()` or `cancel()` must not resurrect
        // the chip.
        setState((prev) =>
          prev.kind === 'streaming' && prev.entryId === entryId
            ? { kind: 'done', entryId, title: p.title }
            : prev,
        )
      }),
    )
    const errorUnlisten = await listen<SuggestTitleErrorEvent>(
      'ai:suggest-title-error',
      filterByEntry<SuggestTitleErrorEvent>((p) => {
        // Prefer the new stable `code` field (R6 backend post-review)
        // over the legacy `error` body string. Falls back so the hook
        // works against both wire shapes during the rollout.
        const code = p.code ?? p.error ?? 'AI_UNKNOWN_ERROR'
        setState((prev) =>
          prev.kind === 'streaming' && prev.entryId === entryId
            ? { kind: 'error', entryId, code }
            : prev,
        )
      }),
    )
    const cancelledUnlisten = await listen<SuggestTitleCancelledEvent>(
      'ai:suggest-title-cancelled',
      filterByEntry<SuggestTitleCancelledEvent>(() => {
        setState((prev) =>
          // The hook's own `cancel()` already optimistically flipped
          // to 'cancelled' — only flip here if state is still
          // streaming (backend cancelled before the user clicked).
          prev.kind === 'streaming' && prev.entryId === entryId
            ? { kind: 'cancelled', entryId }
            : prev,
        )
      }),
    )
    unlistenersRef.current = [tokenUnlisten, completeUnlisten, errorUnlisten, cancelledUnlisten]

    try {
      await suggestTitle(entryId)
    } catch (e) {
      const code = typeof e === 'string' ? e : 'AI_UNKNOWN_ERROR'
      setState({ kind: 'error', entryId, code })
    }
  }, [])

  const cancel = useCallback(async () => {
    const id = activeEntryIdRef.current
    if (!id) return
    // Optimistic state flip — a stuck `streaming` UI while the user
    // waits for the backend to acknowledge a cancel they just clicked
    // is poor UX. The event handlers above guard with
    // `prev.kind === 'streaming'` so a late-arriving complete /
    // cancelled event from this in-flight stream won't resurrect the
    // chip.
    setState((prev) =>
      prev.kind === 'streaming' && prev.entryId === id ? { kind: 'cancelled', entryId: id } : prev,
    )
    try {
      await cancelSuggestion(id)
    } catch {
      /* fire-and-forget */
    }
  }, [])

  const reset = useCallback(() => {
    teardownListeners()
    setState({ kind: 'idle' })
  }, [])

  return { state, suggest, cancel, reset }
}
