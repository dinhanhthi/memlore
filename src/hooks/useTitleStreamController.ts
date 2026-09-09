import { useCallback, useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { cancelSuggestion, suggestTitle, updateEntry } from '../lib/tauri'
import { useTitleStreamStore } from '../stores/titleStreamStore'
import { useEntryStore } from '../stores/entryStore'

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
  code?: string
  error?: string
}
interface SuggestTitleCancelledEvent {
  entry_id: string
}

/**
 * App-level controller that owns the cross-component title-suggestion
 * stream. Exposes `start(entryId)` to kick off a `suggest_title`
 * Tauri call and pipes the streamed tokens into `useTitleStreamStore`
 * so any component (e.g. EntryCard) can render the partial text in
 * place of the title. On completion, the assembled title is persisted
 * via `update_entry` and `memlore:entries-changed` is broadcast so
 * lists, calendar, etc. refresh.
 *
 * Mount this hook once near the app root (it owns the Tauri event
 * listeners and the in-flight entry id). Consumers that need to
 * trigger a stream should call `useTitleStream()`, which re-exposes
 * the same `start()` via a module-level handle the controller sets
 * on mount.
 */
let activeStart: ((entryId: string) => Promise<void>) | null = null

export function useTitleStreamController() {
  const setStreaming = useTitleStreamStore((s) => s.setStreaming)
  const appendPartial = useTitleStreamStore((s) => s.appendPartial)
  const setDone = useTitleStreamStore((s) => s.setDone)
  const setError = useTitleStreamStore((s) => s.setError)
  const reset = useTitleStreamStore((s) => s.reset)
  const activeEntryIdRef = useRef<string | null>(null)
  const unlistenersRef = useRef<UnlistenFn[]>([])

  const teardown = useCallback(() => {
    for (const u of unlistenersRef.current) u()
    unlistenersRef.current = []
  }, [])

  const start = useCallback(
    async (entryId: string) => {
      // Cancel any prior in-flight stream so its events don't leak
      // into the new one's UI state.
      const prior = activeEntryIdRef.current
      if (prior && prior !== entryId) {
        void cancelSuggestion(prior).catch(() => {})
      }
      teardown()
      activeEntryIdRef.current = entryId
      setStreaming(entryId, '')

      const tokenUnlisten = await listen<SuggestTitleTokenEvent>(
        'ai:suggest-title-token',
        (event) => {
          if (event.payload.entry_id !== entryId) return
          appendPartial(entryId, event.payload.delta)
        },
      )
      const completeUnlisten = await listen<SuggestTitleCompleteEvent>(
        'ai:suggest-title-complete',
        (event) => {
          if (event.payload.entry_id !== entryId) return
          const title = event.payload.title
          setDone(entryId, title)
          // Persist, then mutate the shared entry store so the card on
          // the list switches from the streaming partial back to the
          // real (now-updated) title without flashing the stale prop.
          // Fire-and-forget — the optimistic UI already shows the
          // title; a backend write failure surfaces in the console.
          void updateEntry(entryId, title)
            .then((updated) => useEntryStore.getState().updateEntry(updated))
            .catch((err) => console.error('Failed to persist suggested title:', err))
          // Auto-clear after a short delay so the card snaps back to
          // its normal title (now persisted) without the user having
          // to dismiss anything.
          window.setTimeout(() => {
            if (activeEntryIdRef.current === entryId) {
              activeEntryIdRef.current = null
              reset()
            }
          }, 600)
        },
      )
      const errorUnlisten = await listen<SuggestTitleErrorEvent>(
        'ai:suggest-title-error',
        (event) => {
          if (event.payload.entry_id !== entryId) return
          const code = event.payload.code ?? event.payload.error ?? 'AI_UNKNOWN_ERROR'
          setError(entryId, code)
          activeEntryIdRef.current = null
          window.setTimeout(() => {
            reset()
          }, 2500)
        },
      )
      const cancelledUnlisten = await listen<SuggestTitleCancelledEvent>(
        'ai:suggest-title-cancelled',
        (event) => {
          if (event.payload.entry_id !== entryId) return
          if (activeEntryIdRef.current === entryId) {
            activeEntryIdRef.current = null
            reset()
          }
        },
      )
      unlistenersRef.current = [tokenUnlisten, completeUnlisten, errorUnlisten, cancelledUnlisten]

      try {
        await suggestTitle(entryId)
      } catch (e) {
        const code = typeof e === 'string' ? e : 'AI_UNKNOWN_ERROR'
        setError(entryId, code)
        activeEntryIdRef.current = null
        window.setTimeout(() => reset(), 2500)
      }
    },
    [appendPartial, reset, setDone, setError, setStreaming, teardown],
  )

  useEffect(() => {
    activeStart = start
    return () => {
      activeStart = null
      teardown()
      const id = activeEntryIdRef.current
      if (id) void cancelSuggestion(id).catch(() => {})
    }
  }, [start, teardown])
}

/**
 * Consumer-side handle. The controller hook must be mounted somewhere
 * in the tree (typically near the app root) for `start` to actually
 * do anything; otherwise this is a no-op.
 */
export function useTitleStream() {
  const start = useCallback(async (entryId: string) => {
    if (!activeStart) {
      console.warn('useTitleStream: controller not mounted')
      return
    }
    await activeStart(entryId)
  }, [])
  return { start }
}
