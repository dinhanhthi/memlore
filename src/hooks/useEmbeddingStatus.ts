import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect } from 'react'
import {
  getAiProviders,
  getBackfillStatus,
  getBackgroundIndexingSettings,
  getEmbeddingIndexStats,
  getEmbeddingJobStats,
} from '../lib/tauri'
import { useEmbeddingStatusStore, type EmbeddingProviderKind } from '../stores/embeddingStatusStore'
import type {
  BackfillCompleteEvent,
  BackfillProgressEvent,
  ModelDownloadErrorEvent,
  ModelDownloadProgressEvent,
} from '../types/ai'

/** Push `get_embedding_job_stats` paused/error counts into the store.
 *  `modelId` null (no embedder) clears the counts so a leftover stuck
 *  signal cannot survive a provider wipe. */
export async function applyEmbeddingJobStats(modelId: string | null): Promise<void> {
  if (!modelId) {
    useEmbeddingStatusStore.getState().setJobStats({ paused: 0, error: 0 })
    return
  }
  try {
    const job = await getEmbeddingJobStats(modelId)
    useEmbeddingStatusStore.getState().setJobStats({
      paused: job?.paused ?? 0,
      error: job?.error ?? 0,
    })
  } catch (e) {
    console.warn('useEmbeddingStatus: job stats failed', e)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 0, error: 0 })
  }
}

/** Exported for direct unit testing (see `useEmbeddingStatus.test.ts`) —
 *  the pure mapping is cheaper to verify in isolation than by driving the
 *  whole hook through a mocked `get_ai_providers` response. */
export function endpointClassToProviderKind(cls: string | null | undefined): EmbeddingProviderKind {
  if (cls === 'remote') return 'hosted'
  if (cls === 'local') return 'local'
  if (cls === 'on-device') return 'on_device'
  // 'subscription' (chat-only CLI providers) never appears on the embedding
  // slot today — falls back to 'unknown' rather than guessing.
  return 'unknown'
}

/**
 * Embedding/background-indexing status hook — a thin subscriber over the
 * shared `useEmbeddingStatusStore`. Unlike `useSync` (which lazily inits a
 * store-owned singleton listener), this hook owns its own Tauri event
 * subscription per mount, matching `useBackfillStatus`'s cleanup idiom —
 * every consumer gets its own listener, cleaned up on unmount, while all
 * consumers read the same underlying store state.
 *
 * Components never call `invoke()` directly — this hook is the only place
 * that talks to `get_background_indexing_settings`, `get_ai_providers`,
 * `get_embedding_index_stats`, and `get_embedding_job_stats` for status.
 */
export function useEmbeddingStatus() {
  const status = useEmbeddingStatusStore((s) => s.status)
  const pendingCount = useEmbeddingStatusStore((s) => s.pendingCount)
  const providerKind = useEmbeddingStatusStore((s) => s.providerKind)
  const lastError = useEmbeddingStatusStore((s) => s.lastError)
  const downloadProgress = useEmbeddingStatusStore((s) => s.downloadProgress)
  const downloadModelId = useEmbeddingStatusStore((s) => s.downloadModelId)
  const modelError = useEmbeddingStatusStore((s) => s.modelError)

  const setPendingCount = useEmbeddingStatusStore((s) => s.setPendingCount)
  const setProviderKind = useEmbeddingStatusStore((s) => s.setProviderKind)
  const setBackgroundSettings = useEmbeddingStatusStore((s) => s.setBackgroundSettings)
  const setIndexingProgress = useEmbeddingStatusStore((s) => s.setIndexingProgress)
  const setBackfillComplete = useEmbeddingStatusStore((s) => s.setBackfillComplete)
  const setError = useEmbeddingStatusStore((s) => s.setError)
  const setModelDownloadProgress = useEmbeddingStatusStore((s) => s.setModelDownloadProgress)
  const setModelDownloadError = useEmbeddingStatusStore((s) => s.setModelDownloadError)
  const setWorkerRunning = useEmbeddingStatusStore((s) => s.setWorkerRunning)

  /// Re-fetch the settings/stats/provider snapshot. Used on mount and after
  /// any event that can change consent, provider identity, or pending count
  /// (completion, model-changed) — cheaper than threading every field
  /// through the event payloads and keeps a single source of truth in the
  /// backend for anything not carried live by `ai:backfill-progress`.
  const refresh = useCallback(async () => {
    try {
      const [settings, stats, providers, backfill] = await Promise.all([
        getBackgroundIndexingSettings(),
        getEmbeddingIndexStats(),
        getAiProviders(),
        getBackfillStatus(),
      ])
      // The web preview's invoke router returns `null` for unhandled
      // commands (see web/mocks/invokeRouter.ts); guard each payload so a
      // null never throws inside refresh. Real backend responses always
      // carry these fields.
      setBackgroundSettings({
        enabled: settings?.enabled ?? false,
        allowed: settings?.allowed ?? false,
      })
      setPendingCount(stats?.pending ?? 0)
      await applyEmbeddingJobStats(stats?.model_id ?? null)
      setProviderKind(endpointClassToProviderKind(providers?.embedding?.endpointClass ?? null))
      // A worker that is actually running can't be paused — clears a stale
      // `paused` flag after Resume / unlock, where an empty queue means no
      // progress or completion event ever fires to clear it.
      setWorkerRunning(backfill?.running ?? false)
    } catch (e) {
      console.warn('useEmbeddingStatus: refresh failed', e)
    }
  }, [setBackgroundSettings, setPendingCount, setProviderKind, setWorkerRunning])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      try {
        const unProgress = await listen<BackfillProgressEvent>('ai:backfill-progress', (event) => {
          setIndexingProgress(event.payload.indexed, event.payload.total)
        })
        unlisteners.push(unProgress)
        if (cancelled) return

        const unComplete = await listen<BackfillCompleteEvent>('ai:backfill-complete', (event) => {
          setBackfillComplete(event.payload.cancelled)
          void refresh()
        })
        unlisteners.push(unComplete)
        if (cancelled) return

        // Embedding-slot identity changed (provider/model swap or API-key
        // rotation that promoted the endpoint class). Re-fetch rather than
        // hand-derive from the event payload — `requires_consent` alone
        // doesn't tell us the new provider kind.
        const unModelChanged = await listen('ai:backfill-model-changed', () => {
          void refresh()
        })
        unlisteners.push(unModelChanged)
        if (cancelled) return

        // A mid-loop embed failure emits this before the run guard fires
        // `ai:backfill-complete`. Backend sends a Display-formatted
        // AiError, e.g. "AI_PROVIDER_ERROR: <detail>" — keep only the
        // stable code so an i18n lookup can resolve it later.
        const unError = await listen<{ error?: string }>('ai:backfill-error', (event) => {
          const raw = event.payload?.error ?? ''
          const code = raw.split(':', 1)[0].trim() || 'AI_BACKFILL_FAILED'
          setError(code)
        })
        unlisteners.push(unError)
        if (cancelled) return

        // On-device model download progress (Phase 4 Task 5) — the
        // command layer emits this while `start_on_device_model_download`
        // is in flight, with a final 100% tick on success.
        const unDownloadProgress = await listen<ModelDownloadProgressEvent>(
          'ai:model-download-progress',
          (event) => {
            setModelDownloadProgress(event.payload.model_id, event.payload.progress)
          },
        )
        unlisteners.push(unDownloadProgress)
        if (cancelled) return

        const unDownloadError = await listen<ModelDownloadErrorEvent>(
          'ai:model-download-error',
          (event) => {
            setModelDownloadError(event.payload.model_id, event.payload.error)
          },
        )
        unlisteners.push(unDownloadError)
      } catch (e) {
        console.warn('useEmbeddingStatus: subscribe failed', e)
      }
    }

    void subscribe()
    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [
    setIndexingProgress,
    setBackfillComplete,
    setError,
    setModelDownloadProgress,
    setModelDownloadError,
    refresh,
  ])

  return {
    status,
    pendingCount,
    providerKind,
    lastError,
    downloadProgress,
    downloadModelId,
    modelError,
    refresh,
  }
}
