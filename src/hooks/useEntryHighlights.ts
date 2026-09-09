import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  cancelSuggestion,
  clearEntryHighlights,
  generateEntryHighlights,
  getEntryHighlights,
  type EntryHighlights,
} from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

/**
 * Streaming entry-highlights hook (Phase 6 v2 R7).
 *
 * On mount: load the cached highlights (if any) for `entryId` so the
 * card renders instantly when the user re-opens an entry.
 *
 * `generate(force?)` starts the backend stream:
 * - On `ai:highlights-token`: accumulate into `partial`, transition to
 *   `kind: 'streaming'`.
 * - On `ai:highlights-complete`: flip to `kind: 'done'` with the final
 *   markdown + `fromCache` flag.
 * - On `ai:highlights-error`: flip to `kind: 'error'` with the stable
 *   `code` field.
 * - On `ai:highlights-cancelled`: flip to `kind: 'cancelled'`.
 *
 * `cancel()` fires the backend cancellation token + optimistically flips
 * local state. `clear()` wipes the cached row + flips back to `idle`.
 *
 * All event handlers GUARD with `prev.kind === 'streaming' &&
 * prev.entryId === entryId` so a late-arriving complete after the user
 * has already navigated away can't resurrect 'done' state.
 */
export type HighlightsState =
  | { kind: 'idle'; entryId: string; cached: EntryHighlights | null }
  | { kind: 'streaming'; entryId: string; partial: string }
  | {
      kind: 'done'
      entryId: string
      markdown: string
      generatedAt: number | null
      modelId: string | null
      fromCache: boolean
    }
  | { kind: 'error'; entryId: string; code: string; message?: string }
  | { kind: 'cancelled'; entryId: string }

interface HighlightsTokenEvent {
  key: string
  delta: string
}
interface HighlightsCompleteEvent {
  key: string
  markdown: string
  generated_at: number | null
  model_id: string | null
  from_cache: boolean
}
interface HighlightsErrorEvent {
  key: string
  code: string
  message?: string
}
interface HighlightsCancelledEvent {
  key: string
}

export function useEntryHighlights(entryId: string | null) {
  const [state, setState] = useState<HighlightsState>({
    kind: 'idle',
    entryId: entryId ?? '',
    cached: null,
  })
  const unlistenersRef = useRef<UnlistenFn[]>([])
  const activeIdRef = useRef<string | null>(null)
  // Mirror the invisible session so the cached highlights of an invisible
  // entry are only loaded by id when the session is unlocked.
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)

  function teardownListeners() {
    for (const u of unlistenersRef.current) u()
    unlistenersRef.current = []
  }

  // Load the cached row when entryId changes. Resets the state to
  // `idle` so a partial-streaming run from a previous entry isn't
  // visible after the user navigates. ALSO best-effort cancels any
  // in-flight stream we kicked off for the *previous* entry — without
  // this, navigating away mid-stream would leave the backend churning
  // until the provider closes the SSE connection (and would still
  // burn provider tokens we'll never display).
  useEffect(() => {
    const prevId = activeIdRef.current
    if (prevId && prevId !== entryId) {
      void cancelSuggestion(`highlights:${prevId}`).catch(() => {})
    }
    activeIdRef.current = entryId
    teardownListeners()
    if (!entryId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch reset; would need TanStack Query to fix properly
      setState({ kind: 'idle', entryId: '', cached: null })
      return
    }
    let cancelled = false
    void getEntryHighlights(entryId, activeVaultId)
      .then((cached) => {
        if (cancelled) return
        setState({ kind: 'idle', entryId, cached })
      })
      .catch(() => {
        if (cancelled) return
        setState({ kind: 'idle', entryId, cached: null })
      })
    return () => {
      cancelled = true
    }
  }, [entryId, activeVaultId])

  // Tear down on unmount; best-effort cancel any in-flight stream.
  useEffect(() => {
    return () => {
      teardownListeners()
      const id = activeIdRef.current
      if (id) {
        // The backend stream key is `highlights:{entry_id}` per
        // commands/ai.rs. Cancel via the same registry the suggest-
        // title cancel uses; mismatched keys are no-ops on the
        // backend side.
        void cancelSuggestion(`highlights:${id}`).catch(() => {})
      }
    }
  }, [])

  const generate = useCallback(
    async (force = false) => {
      if (!entryId) return
      teardownListeners()
      setState({ kind: 'streaming', entryId, partial: '' })

      const filterByKey = <T extends { key: string }>(
        handler: (payload: T) => void,
      ): ((event: { payload: T }) => void) => {
        return (event) => {
          if (event.payload.key !== entryId) return
          handler(event.payload)
        }
      }

      const tokenUnlisten = await listen<HighlightsTokenEvent>(
        'ai:highlights-token',
        filterByKey<HighlightsTokenEvent>((p) => {
          setState((prev) =>
            prev.kind === 'streaming' && prev.entryId === entryId
              ? { ...prev, partial: prev.partial + p.delta }
              : prev,
          )
        }),
      )
      const completeUnlisten = await listen<HighlightsCompleteEvent>(
        'ai:highlights-complete',
        filterByKey<HighlightsCompleteEvent>((p) => {
          // Cache-hit path emits `from_cache: true` with no token
          // events — guard accepts both `streaming` AND `idle` so the
          // synthetic complete promotes the card to `done` cleanly.
          setState((prev) => {
            if ((prev.kind === 'streaming' || prev.kind === 'idle') && prev.entryId === entryId) {
              return {
                kind: 'done',
                entryId,
                markdown: p.markdown,
                generatedAt: p.generated_at,
                modelId: p.model_id,
                fromCache: p.from_cache,
              }
            }
            return prev
          })
        }),
      )
      const errorUnlisten = await listen<HighlightsErrorEvent>(
        'ai:highlights-error',
        filterByKey<HighlightsErrorEvent>((p) => {
          setState((prev) =>
            (prev.kind === 'streaming' || prev.kind === 'idle') && prev.entryId === entryId
              ? { kind: 'error', entryId, code: p.code, message: p.message }
              : prev,
          )
        }),
      )
      const cancelledUnlisten = await listen<HighlightsCancelledEvent>(
        'ai:highlights-cancelled',
        filterByKey<HighlightsCancelledEvent>(() => {
          setState((prev) =>
            prev.kind === 'streaming' && prev.entryId === entryId
              ? { kind: 'cancelled', entryId }
              : prev,
          )
        }),
      )
      unlistenersRef.current = [tokenUnlisten, completeUnlisten, errorUnlisten, cancelledUnlisten]

      try {
        await generateEntryHighlights(entryId, force)
      } catch (e) {
        const code = typeof e === 'string' ? e : 'AI_UNKNOWN_ERROR'
        setState({ kind: 'error', entryId, code })
      }
    },
    [entryId],
  )

  const cancel = useCallback(async () => {
    if (!entryId) return
    setState((prev) =>
      prev.kind === 'streaming' && prev.entryId === entryId ? { kind: 'cancelled', entryId } : prev,
    )
    try {
      await cancelSuggestion(`highlights:${entryId}`)
    } catch {
      /* fire-and-forget */
    }
  }, [entryId])

  const clear = useCallback(async () => {
    if (!entryId) return
    teardownListeners()
    try {
      await clearEntryHighlights(entryId)
    } catch {
      /* fire-and-forget */
    }
    setState({ kind: 'idle', entryId, cached: null })
  }, [entryId])

  return { state, generate, cancel, clear }
}
