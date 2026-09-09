import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  acceptBackgroundIndexingHostedConsent as acceptBackgroundIndexingHostedConsentCmd,
  getBackfillStatus,
  getBackgroundIndexingSettings,
  getEmbeddingIndexStats,
  pauseBackfill as pauseBackfillCmd,
  setBackgroundIndexingEnabled as setBackgroundIndexingEnabledCmd,
  startBackfill as startBackfillCmd,
  type BackgroundIndexingSettings,
} from '../lib/tauri'
import { applyEmbeddingJobStats } from './useEmbeddingStatus'
import { useEmbeddingStatusStore, type EmbeddingProviderKind } from '../stores/embeddingStatusStore'
import type {
  BackfillCompleteEvent,
  BackfillModelChangedEvent,
  BackfillProgressEvent,
  BackfillStatus,
  EmbeddingIndexStats,
} from '../types/ai'

/// Whether enabling background indexing right now requires the hosted
/// token-cost consent step first. `hostedConsentAt` is scoped to the
/// CURRENT embedding provider/model identity — the backend clears it
/// whenever that identity changes (see `persist_embed_config`), so a
/// non-null value here always means "already consented for what's
/// configured today". Local/on-device providers never need this step.
export function needsHostedConsent(
  providerKind: EmbeddingProviderKind,
  hostedConsentAt: number | null,
): boolean {
  return providerKind === 'hosted' && hostedConsentAt == null
}

/// Empty status used as the initial render state and the post-complete /
/// post-cancel reset value. Mirrors the Rust `BackfillStatus::default`.
const IDLE_STATUS: BackfillStatus = {
  running: false,
  model_id: null,
  indexed: 0,
  total: 0,
}

const IDLE_INDEX_STATS: EmbeddingIndexStats = {
  model_id: null,
  indexed: 0,
  total: 0,
  pending: 0,
}

const IDLE_BACKGROUND_SETTINGS: BackgroundIndexingSettings = {
  enabled: false,
  hostedConsentAt: null,
  allowed: false,
}

export interface UseBackfillStatusReturn {
  status: BackfillStatus
  indexStats: EmbeddingIndexStats
  /// Stable reference for the current entry being indexed (for the
  /// "Indexing entry: …" affordance). Cleared on completion.
  currentEntryId: string | null
  /// Last terminal outcome of a backfill run, or `null` if no run has
  /// completed since mount. Lets the UI distinguish a clean finish from a
  /// user-initiated pause without holding stale `running = true` state.
  lastCompletion: BackfillCompleteEvent | null
  /// Most recent `ai:backfill-model-changed` payload, or `null` if none
  /// has fired since mount. Set once whenever the embedding-slot identity
  /// changes; Phase 3 builds the UI that reacts to it (e.g. "re-indexing
  /// for new model" / "needs consent"). This hook only surfaces the raw
  /// event — no dismiss/reset affordance yet.
  modelChangeNotice: BackfillModelChangedEvent | null
  /// `true` while we wait for the OS-level event stream to attach. The
  /// initial status fetch finishes regardless; this only flags the live
  /// subscription.
  loading: boolean
  error: string | null
  start: (force?: boolean) => Promise<void>
  pause: () => Promise<void>
  refreshStats: () => Promise<void>
  /// `ai_background_indexing_enabled` master toggle — whether the
  /// automatic (debounced) worker is allowed to run at all.
  backgroundEnabled: boolean
  /// `Some(unix_seconds)` once the hosted token-cost notice has been
  /// accepted for the current embedding provider/model, else `null`.
  hostedConsentAt: number | null
  /// Flip the master toggle. Does NOT touch hosted consent — see
  /// `set_background_indexing_enabled` on the backend.
  setBackgroundEnabled: (enabled: boolean) => Promise<void>
  /// Record acceptance of the hosted token-cost notice for the current
  /// embedding provider/model.
  acceptHostedConsent: () => Promise<void>
  /// Re-fetch the master toggle + hosted-consent snapshot.
  refreshBackgroundSettings: () => Promise<void>
}

/// Hook that subscribes to backfill progress + completion events and tracks
/// the current run's status. The initial value is hydrated by polling
/// `get_backfill_status` once on mount so a hot-reload that missed live
/// events still shows the correct progress.
export function useBackfillStatus(): UseBackfillStatusReturn {
  const [status, setStatus] = useState<BackfillStatus>(IDLE_STATUS)
  const [indexStats, setIndexStats] = useState<EmbeddingIndexStats>(IDLE_INDEX_STATS)
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null)
  const [lastCompletion, setLastCompletion] = useState<BackfillCompleteEvent | null>(null)
  const [modelChangeNotice, setModelChangeNotice] = useState<BackfillModelChangedEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backgroundEnabled, setBackgroundEnabledState] = useState(false)
  const [hostedConsentAt, setHostedConsentAt] = useState<number | null>(null)
  // Mirror of `status` for callbacks that don't want to re-bind on every
  // change (event listeners spawned in useEffect).
  const statusRef = useRef<BackfillStatus>(IDLE_STATUS)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  // Hydrate from the backend exactly once. This runs in parallel with the
  // event subscription below — if a live `ai:backfill-progress` event lands
  // first, we must not let the stale hydration reading clobber it. The
  // `statusRef.current.running` guard means the hydrated value only takes
  // effect when the live stream hasn't yet reported a running backfill.
  const refreshStats = useCallback(async () => {
    try {
      const stats = await getEmbeddingIndexStats()
      // The web preview's invoke router returns `null` for unhandled
      // commands (see web/mocks/invokeRouter.ts); fall back to the idle
      // shape so a null never reaches the store. The real backend always
      // returns a fully-populated struct.
      const next = stats ?? IDLE_INDEX_STATS
      setIndexStats(next)
      await applyEmbeddingJobStats(next.model_id)
    } catch (e) {
      setError(`AI_BACKFILL_STATS_FAILED: ${String(e)}`)
    }
  }, [])

  // Re-fetch the master toggle + hosted-consent snapshot. Called on mount
  // and whenever the embedding-slot identity changes (`ai:backfill-model-
  // changed`) — the backend clears `hosted_consent_at` on a provider/model
  // swap, so a stale local copy would keep gating a consent step the user
  // already cleared, or vice versa.
  const refreshBackgroundSettings = useCallback(async () => {
    try {
      const s = (await getBackgroundIndexingSettings()) ?? IDLE_BACKGROUND_SETTINGS
      setBackgroundEnabledState(s.enabled)
      setHostedConsentAt(s.hostedConsentAt)
    } catch (e) {
      setError(`AI_BACKGROUND_SETTINGS_FAILED: ${String(e)}`)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getBackfillStatus(),
      getEmbeddingIndexStats(),
      getBackgroundIndexingSettings(),
    ])
      .then(([s, stats, backgroundSettings]) => {
        if (cancelled) return
        if (!statusRef.current.running) {
          setStatus(s ?? IDLE_STATUS)
        }
        const nextStats = stats ?? IDLE_INDEX_STATS
        setIndexStats(nextStats)
        void applyEmbeddingJobStats(nextStats.model_id)
        const bg = backgroundSettings ?? IDLE_BACKGROUND_SETTINGS
        setBackgroundEnabledState(bg.enabled)
        setHostedConsentAt(bg.hostedConsentAt)
      })
      .catch((e) => {
        if (!cancelled) setError(`AI_BACKFILL_STATUS_FAILED: ${String(e)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Subscribe to Tauri events once on mount. Each `listen` call's unlistener
  // is pushed into the cleanup list immediately after it resolves so a
  // mid-setup rejection (or unmount during await) cannot leak handlers.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      try {
        const unProgress = await listen<BackfillProgressEvent>('ai:backfill-progress', (event) => {
          const { model_id, indexed, total, current_entry_id } = event.payload
          setStatus({ running: true, model_id, indexed, total })
          setCurrentEntryId(current_entry_id)
        })
        unlisteners.push(unProgress)
        if (cancelled) return

        const unComplete = await listen<BackfillCompleteEvent>('ai:backfill-complete', (event) => {
          setLastCompletion(event.payload)
          setStatus(IDLE_STATUS)
          setCurrentEntryId(null)
          void refreshStats()
        })
        unlisteners.push(unComplete)
        if (cancelled) return

        const unModelChanged = await listen<BackfillModelChangedEvent>(
          'ai:backfill-model-changed',
          (event) => {
            setModelChangeNotice(event.payload)
            void refreshBackgroundSettings()
          },
        )
        unlisteners.push(unModelChanged)
        if (cancelled) return

        // A mid-loop embed failure emits this, then the loop breaks and the
        // run guard emits `ai:backfill-complete` with `cancelled: false`.
        // Without capturing the error here the failure is swallowed and the
        // UI falsely renders "All entries indexed" while progress stays stuck.
        const unError = await listen<{ error?: string }>('ai:backfill-error', (event) => {
          const raw = event.payload?.error ?? ''
          // Backend sends a Display-formatted AiError, e.g.
          // "AI_PROVIDER_ERROR: <detail>". Keep only the stable code so the
          // i18n lookup resolves; fall back to a generic backfill code.
          const code = raw.split(':', 1)[0].trim() || 'AI_BACKFILL_FAILED'
          setError(code)
        })
        unlisteners.push(unError)
      } catch (e) {
        setError(`AI_BACKFILL_SUBSCRIBE_FAILED: ${String(e)}`)
      } finally {
        setLoading(false)
      }
    }

    void subscribe()
    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [refreshStats, refreshBackgroundSettings])

  const start = useCallback(async (force = false) => {
    setError(null)
    setLastCompletion(null)
    try {
      const initial = await startBackfillCmd(force)
      setStatus(initial)
      // Progress events only fire after each entry finishes embedding, so
      // without an optimistic flip the status row stays on "Waiting for
      // edits to settle" for the whole provider round-trip after Index now
      // / Rebuild. Re-read pending: if the unstick pass left work, show
      // indexing immediately; empty queue is a no-op (leave status alone).
      const stats = (await getEmbeddingIndexStats()) ?? IDLE_INDEX_STATS
      setIndexStats(stats)
      await applyEmbeddingJobStats(stats.model_id)
      const store = useEmbeddingStatusStore.getState()
      store.setPendingCount(stats.pending)
      if (stats.pending > 0) {
        store.beginIndexing()
      }
    } catch (e) {
      setError(String(e))
      throw e
    }
  }, [])

  const pause = useCallback(async () => {
    try {
      await pauseBackfillCmd()
    } catch (e) {
      setError(String(e))
      throw e
    }
  }, [])

  const setBackgroundEnabled = useCallback(async (enabled: boolean) => {
    try {
      await setBackgroundIndexingEnabledCmd(enabled)
      setBackgroundEnabledState(enabled)
    } catch (e) {
      setError(String(e))
      throw e
    }
  }, [])

  const acceptHostedConsent = useCallback(async () => {
    try {
      const at = await acceptBackgroundIndexingHostedConsentCmd()
      setHostedConsentAt(at)
    } catch (e) {
      setError(String(e))
      throw e
    }
  }, [])

  return {
    status,
    indexStats,
    currentEntryId,
    lastCompletion,
    modelChangeNotice,
    loading,
    error,
    start,
    pause,
    refreshStats,
    backgroundEnabled,
    hostedConsentAt,
    setBackgroundEnabled,
    acceptHostedConsent,
    refreshBackgroundSettings,
  }
}
