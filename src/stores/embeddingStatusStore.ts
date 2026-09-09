import { create } from 'zustand'
import type { EmbedSyncDecisionSlotView } from '../types/ai'

/**
 * Global embedding/background-indexing status — single source of truth for
 * every UI surface that needs to know "is the background indexer doing
 * anything right now" (footer indicator, AI Settings embedding section,
 * RAG feature hints). Mirrors the `syncStore` shape/idiom: one shared
 * Zustand store, pure setter actions, a derived `status` field recomputed
 * after every mutation.
 *
 * Unlike `syncStore`, this store does NOT own the Tauri event listener
 * itself — `useEmbeddingStatus` / `useEmbeddingSyncDecision` (per-hook-mount)
 * subscribe and call these actions. That keeps this file pure state +
 * derivation, easy to unit test without mocking `@tauri-apps/api/event`.
 */

export type EmbeddingIndexingStatus =
  | 'idle'
  | 'waiting'
  | 'stuck'
  | 'indexing'
  | 'downloading_model'
  | 'paused'
  | 'needs_consent'
  | 'needs_decision'
  | 'error'
  | 'model_error'

/** Job-row counts that the worker cannot claim without a user re-queue. */
export interface EmbeddingJobStuckCounts {
  paused: number
  error: number
}

/** `on_device` is a forward value for Phase 4 (on-device embedding runtime)
 *  — no code path sets it yet, but the type exists now so downstream UI
 *  can switch on it without a future breaking change. */
export type EmbeddingProviderKind = 'local' | 'hosted' | 'on_device' | 'unknown'

interface EmbeddingStatusState {
  // ── Derived snapshot ─────────────────────────────────────────────────────
  status: EmbeddingIndexingStatus
  pendingCount: number
  providerKind: EmbeddingProviderKind
  lastError: string | null
  /** 0-100, or `null` when no on-device model download is in flight/known. */
  downloadProgress: number | null
  /** The on-device model id the last download progress/error event was
   *  about — `null` until the first `ai:model-download-*` event arrives. */
  downloadModelId: string | null
  /** Set by `ai:model-download-error`; cleared by the next progress event. */
  modelError: string | null

  // ── Embedding sync decision (multi-device mismatch / key blocks) ──────────
  /** Latest per-slot decision snapshots from get_embedding_sync_decisions
   *  or `ai:embedding-decision-needed`. Empty until first refresh. */
  decisionSlots: EmbedSyncDecisionSlotView[]
  /** Whether the decision modal is currently open. */
  decisionModalOpen: boolean

  // ── Derivation inputs (internal) ─────────────────────────────────────────
  /** `ai_background_indexing_enabled` master toggle. */
  backgroundEnabled: boolean
  /** Mirrors backend `background_indexing_allowed` — `true` iff the worker
   *  may spend a provider call right now (false while a hosted slot is
   *  enabled but not yet consented). */
  allowed: boolean
  /** `true` while the last-known progress event reported an active run. */
  isIndexing: boolean
  /** `true` while an on-device model download is in flight (progress < 100). */
  isDownloadingModel: boolean
  /** `true` after a user-initiated pause (`ai:backfill-complete` with
   *  `cancelled: true`); cleared by the next progress event. */
  paused: boolean
  /** `entry_embedding_jobs` paused+error counts from `get_embedding_job_stats`. */
  jobStats: EmbeddingJobStuckCounts

  // ── Actions ───────────────────────────────────────────────────────────────
  setPendingCount: (pendingCount: number) => void
  /** Job-table paused/error counts — used to distinguish debounce-wait from stuck. */
  setJobStats: (jobStats: EmbeddingJobStuckCounts) => void
  setProviderKind: (providerKind: EmbeddingProviderKind) => void
  setBackgroundSettings: (settings: { enabled: boolean; allowed: boolean }) => void
  /** Called on `ai:backfill-progress`. Derives `pendingCount` from
   *  `total - indexed` (matches the backend's own `total = indexed + pending`
   *  computation) and clears any prior error/paused state — a fresh
   *  progress event proves the worker is alive and running. */
  setIndexingProgress: (indexed: number, total: number) => void
  /**
   * Optimistic "work is in flight" flip — used by Index now / Rebuild after
   * `start_backfill` requeues jobs. Progress events only fire *after* each
   * entry finishes embedding, so without this the UI stays on
   * "Waiting for edits to settle" for the entire provider round-trip.
   * Cleared by `setBackfillComplete` (caught-up or pause) or `setError`.
   */
  beginIndexing: () => void
  /** Called on `ai:backfill-complete`. `cancelled` distinguishes a
   *  user-initiated pause from a natural run completion. */
  setBackfillComplete: (cancelled: boolean) => void
  /** Backend truth from `get_backfill_status` — a running worker PROVES the
   *  index is not paused, so `true` clears the `paused` flag. Needed because
   *  a resumed worker with an empty queue emits no progress/complete event
   *  at all (see `run_backfill_loop`), which used to leave "Paused" stuck on
   *  screen forever. `false` is deliberately NOT evidence of a pause: the
   *  slot is also vacant between runs and while a cancel is still
   *  propagating — only `setBackfillComplete(true)` sets `paused`. */
  setWorkerRunning: (running: boolean) => void
  /** Called on `ai:backfill-error`, or with `null` to clear. A non-null
   *  error also stops `isIndexing` — the worker loop breaks on embed
   *  failure. */
  setError: (error: string | null) => void
  /** Called on `ai:model-download-progress`. `progress` is 0-100; 100 marks
   *  the download as finished (mirrors the command layer's final tick),
   *  clearing `isDownloadingModel` and any prior `modelError`. */
  setModelDownloadProgress: (modelId: string, progress: number) => void
  /** Called on `ai:model-download-error`. Stops `isDownloadingModel` — a
   *  failed download isn't "in flight" anymore. */
  setModelDownloadError: (modelId: string, error: string) => void
  /** Replace decision slot snapshots and re-derive status. */
  setDecisionSlots: (slots: EmbedSyncDecisionSlotView[]) => void
  setDecisionModalOpen: (open: boolean) => void
}

const initialSnapshot = {
  status: 'idle' as EmbeddingIndexingStatus,
  pendingCount: 0,
  providerKind: 'unknown' as EmbeddingProviderKind,
  lastError: null as string | null,
  downloadProgress: null as number | null,
  downloadModelId: null as string | null,
  modelError: null as string | null,
  decisionSlots: [] as EmbedSyncDecisionSlotView[],
  decisionModalOpen: false,
  backgroundEnabled: false,
  allowed: false,
  isIndexing: false,
  isDownloadingModel: false,
  paused: false,
  jobStats: { paused: 0, error: 0 } as EmbeddingJobStuckCounts,
}

type DerivationInputs = Pick<
  EmbeddingStatusState,
  | 'lastError'
  | 'modelError'
  | 'decisionSlots'
  | 'backgroundEnabled'
  | 'allowed'
  | 'providerKind'
  | 'paused'
  | 'isIndexing'
  | 'isDownloadingModel'
  | 'pendingCount'
  | 'jobStats'
>

/** True when any slot needs user attention (pending decision or paused
 *  with re-openable modal — mirrors backend `needs_modal`). */
export function anySlotNeedsDecision(slots: EmbedSyncDecisionSlotView[]): boolean {
  return slots.some((s) => s.needsModal)
}

/**
 * Priority order (first match wins):
 *   1. `error` — most actionable; a failed embed call needs attention
 *      regardless of what else is true.
 *   2. `model_error` — an on-device model download failed. Distinct from
 *      `error` (which covers embed-call failures) so the footer can point
 *      the user at the download rather than a generic provider error.
 *   3. `needs_decision` — multi-device embed sync decision pending/paused
 *      (model mismatch, missing key, …). Outranks consent: the user must
 *      choose re-embed / switch / pause before workers spend tokens.
 *   4. `needs_consent` — hosted + enabled + not yet allowed. Nothing else
 *      matters until the user consents; overrides a stale `paused` flag.
 *      (Mutually exclusive with on-device states — on-device is
 *      auto/no-consent by construction.)
 *   5. `downloading_model` — a model download is actively in flight. Ranks
 *      above `indexing`/`waiting`/`paused` because the worker can't index
 *      anything until the model it's waiting on is ready — a download in
 *      progress is the most relevant thing to show.
 *   6. `paused` — user explicitly stopped the worker.
 *   7. `indexing` — a run is actively progressing.
 *   8. `stuck` — background indexing is on, no run is in flight, and
 *      every pending job is paused (unclaimable). Error rows are
 *      claimable; a leftover paused row next to a real queue is waiting.
 *   9. `waiting` — enabled with pending work, debounce hasn't fired yet.
 *  10. `idle` — nothing to do.
 */
function deriveStatus(s: DerivationInputs): EmbeddingIndexingStatus {
  if (s.lastError) return 'error'
  if (s.modelError) return 'model_error'
  if (anySlotNeedsDecision(s.decisionSlots)) return 'needs_decision'
  if (s.backgroundEnabled && !s.allowed && s.providerKind === 'hosted') return 'needs_consent'
  if (s.isDownloadingModel) return 'downloading_model'
  if (s.paused) return 'paused'
  if (s.isIndexing) return 'indexing'
  if (
    s.backgroundEnabled &&
    !s.isIndexing &&
    s.jobStats.paused > 0 &&
    s.pendingCount === s.jobStats.paused
  ) {
    return 'stuck'
  }
  if (s.backgroundEnabled && s.pendingCount > 0) return 'waiting'
  return 'idle'
}

export const useEmbeddingStatusStore = create<EmbeddingStatusState>()((set) => ({
  ...initialSnapshot,

  setPendingCount: (pendingCount) =>
    set((s) => ({ pendingCount, status: deriveStatus({ ...s, pendingCount }) })),

  setJobStats: (jobStats) => set((s) => ({ jobStats, status: deriveStatus({ ...s, jobStats }) })),

  setProviderKind: (providerKind) =>
    set((s) => ({ providerKind, status: deriveStatus({ ...s, providerKind }) })),

  setBackgroundSettings: ({ enabled, allowed }) =>
    set((s) => ({
      backgroundEnabled: enabled,
      allowed,
      status: deriveStatus({ ...s, backgroundEnabled: enabled, allowed }),
    })),

  setIndexingProgress: (indexed, total) =>
    set((s) => {
      const pendingCount = Math.max(total - indexed, 0)
      return {
        pendingCount,
        isIndexing: true,
        paused: false,
        lastError: null,
        status: deriveStatus({
          ...s,
          pendingCount,
          isIndexing: true,
          paused: false,
          lastError: null,
        }),
      }
    }),

  beginIndexing: () =>
    set((s) => ({
      isIndexing: true,
      paused: false,
      lastError: null,
      status: deriveStatus({
        ...s,
        isIndexing: true,
        paused: false,
        lastError: null,
      }),
    })),

  setBackfillComplete: (cancelled) =>
    set((s) => ({
      isIndexing: false,
      paused: cancelled,
      status: deriveStatus({ ...s, isIndexing: false, paused: cancelled }),
    })),

  setWorkerRunning: (running) =>
    set((s) => {
      if (!running || !s.paused) return s
      return { paused: false, status: deriveStatus({ ...s, paused: false }) }
    }),

  setError: (error) =>
    set((s) => {
      const isIndexing = error ? false : s.isIndexing
      return {
        lastError: error,
        isIndexing,
        status: deriveStatus({ ...s, lastError: error, isIndexing }),
      }
    }),

  setModelDownloadProgress: (modelId, progress) =>
    set((s) => {
      const isDownloadingModel = progress < 100
      return {
        downloadModelId: modelId,
        downloadProgress: progress,
        isDownloadingModel,
        modelError: null,
        status: deriveStatus({ ...s, isDownloadingModel, modelError: null }),
      }
    }),

  setModelDownloadError: (modelId, error) =>
    set((s) => ({
      downloadModelId: modelId,
      modelError: error,
      isDownloadingModel: false,
      status: deriveStatus({ ...s, isDownloadingModel: false, modelError: error }),
    })),

  setDecisionSlots: (decisionSlots) =>
    set((s) => ({
      decisionSlots,
      status: deriveStatus({ ...s, decisionSlots }),
    })),

  setDecisionModalOpen: (decisionModalOpen) => set({ decisionModalOpen }),
}))

/** Test-only reset — zeroes state so each test starts with a clean slate. */
export function __resetEmbeddingStatusStoreForTests() {
  useEmbeddingStatusStore.setState({ ...initialSnapshot })
}
