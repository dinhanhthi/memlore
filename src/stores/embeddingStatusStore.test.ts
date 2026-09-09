import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetEmbeddingStatusStoreForTests,
  useEmbeddingStatusStore,
} from './embeddingStatusStore'

beforeEach(() => {
  __resetEmbeddingStatusStoreForTests()
})

describe('embeddingStatusStore', () => {
  it('starts idle with unknown provider kind and no pending work', () => {
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('idle')
    expect(s.pendingCount).toBe(0)
    expect(s.providerKind).toBe('unknown')
    expect(s.lastError).toBeNull()
  })

  // ── idle → waiting ────────────────────────────────────────────────────────

  it('pending work with background indexing enabled transitions idle → waiting', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')

    useEmbeddingStatusStore.getState().setPendingCount(5)
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')
    expect(useEmbeddingStatusStore.getState().pendingCount).toBe(5)
  })

  it('pending work while background indexing is disabled stays idle', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: false, allowed: false })
    useEmbeddingStatusStore.getState().setPendingCount(5)
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  // ── waiting → indexing ───────────────────────────────────────────────────

  it('a progress event transitions waiting → indexing and derives pendingCount from total - indexed', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(10)
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')

    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('indexing')
    expect(s.pendingCount).toBe(7)
  })

  // Index now / Rebuild: start_backfill requeues jobs but progress only
  // fires after each embed completes — beginIndexing flips the status
  // immediately so the settings row shows "Indexing N pending" mid-request.
  it('beginIndexing transitions waiting → indexing without changing pendingCount', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(3)
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')

    useEmbeddingStatusStore.getState().beginIndexing()
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('indexing')
    expect(s.pendingCount).toBe(3)
    expect(s.paused).toBe(false)
    expect(s.lastError).toBeNull()
  })

  it('beginIndexing clears a prior error and a stale paused flag', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(2)
    useEmbeddingStatusStore.getState().setIndexingProgress(0, 2)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    useEmbeddingStatusStore.getState().setError('AI_PROVIDER_ERROR')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')

    useEmbeddingStatusStore.getState().beginIndexing()
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('indexing')
    expect(s.paused).toBe(false)
    expect(s.lastError).toBeNull()
  })

  // ── indexing → paused ────────────────────────────────────────────────────

  it('a cancelled completion transitions indexing → paused', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    expect(useEmbeddingStatusStore.getState().status).toBe('indexing')

    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('paused')
    expect(s.paused).toBe(true)
  })

  it('a non-cancelled completion with no remaining pending work returns to idle', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(10, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(false)
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('setIndexingProgress clamps pendingCount to zero when indexed exceeds total', () => {
    useEmbeddingStatusStore.getState().setIndexingProgress(12, 10)
    expect(useEmbeddingStatusStore.getState().pendingCount).toBe(0)
  })

  it('setIndexingProgress clears a prior error and re-derives status away from error', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setError('AI_PROVIDER_ERROR')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')

    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    const s = useEmbeddingStatusStore.getState()
    expect(s.lastError).toBeNull()
    expect(s.status).toBe('indexing')
  })

  it('a new progress event clears a prior paused flag', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    useEmbeddingStatusStore.getState().setIndexingProgress(4, 10)
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('indexing')
    expect(s.paused).toBe(false)
  })

  // Regression: resuming with an already-drained queue emits NO progress and
  // NO completion event (`run_backfill_loop` only emits when work happens),
  // so the `paused` flag survived forever and the settings row + footer kept
  // reading "Paused" while the worker was live. `get_backfill_status` is the
  // only signal in that case.
  it('a running worker clears a stale paused flag', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(10, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    useEmbeddingStatusStore.getState().setWorkerRunning(true)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(false)
    expect(s.status).toBe('idle')
  })

  it('a NOT-running worker never sets paused on its own', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    useEmbeddingStatusStore.getState().setWorkerRunning(false)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(false)
    expect(s.status).toBe('indexing')
  })

  // The load-bearing half of the invariant: the slot is ALSO vacant right
  // after a pause (`BackfillRunGuard::drop` clears it before emitting
  // `ai:backfill-complete`), so a `running: false` reading must never be
  // mistaken for "resume" — a genuine pause has to survive it.
  it('a NOT-running worker leaves a genuine pause intact', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    useEmbeddingStatusStore.getState().setWorkerRunning(false)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(true)
    expect(s.status).toBe('paused')
  })

  // A running worker only clears `paused`; it must not promote the status
  // past a higher-priority state (error, needs_consent, …).
  it('a running worker does not override a higher-priority status', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')

    useEmbeddingStatusStore.getState().setWorkerRunning(true)
    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(false)
    expect(s.status).toBe('needs_consent')
  })

  // ── needs_consent derivation ─────────────────────────────────────────────

  it('hosted provider enabled without consent surfaces needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')
  })

  it('local provider enabled without consent flag set does NOT surface needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('local')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).not.toBe('needs_consent')
  })

  it('hosted provider becomes allowed after consent, clearing needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')

    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('hosted provider disabled entirely does not surface needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: false, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('needs_consent overrides a stale paused flag (model swap clears consent while paused persists)', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')

    // Simulates an embedding-model swap: the backend clears hosted consent
    // (`allowed` flips false) while the stale local `paused` flag is still
    // true — `needs_consent` must win over `paused` (cf-review C2).
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })

    const s = useEmbeddingStatusStore.getState()
    expect(s.paused).toBe(true)
    expect(s.status).toBe('needs_consent')
  })

  // ── error takes priority ─────────────────────────────────────────────────

  it('an error event transitions indexing → error and stops isIndexing', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)

    useEmbeddingStatusStore.getState().setError('AI_PROVIDER_ERROR')
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('error')
    expect(s.isIndexing).toBe(false)
    expect(s.lastError).toBe('AI_PROVIDER_ERROR')
  })

  it('error takes priority over an active needs_consent condition', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')

    useEmbeddingStatusStore.getState().setError('AI_BACKFILL_FAILED')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')
  })

  it('clearing the error (null) does not force isIndexing off and re-derives status', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(5)
    useEmbeddingStatusStore.getState().setError('SOME_ERROR')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')

    useEmbeddingStatusStore.getState().setError(null)
    const s = useEmbeddingStatusStore.getState()
    expect(s.lastError).toBeNull()
    expect(s.status).toBe('waiting')
  })

  // ── pendingCount / providerKind plumbing ─────────────────────────────────

  it('setPendingCount updates pendingCount independently of other fields', () => {
    useEmbeddingStatusStore.getState().setPendingCount(42)
    expect(useEmbeddingStatusStore.getState().pendingCount).toBe(42)
  })

  it('setProviderKind accepts the forward on_device value without deriving needs_consent', () => {
    useEmbeddingStatusStore.getState().setProviderKind('on_device')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    expect(useEmbeddingStatusStore.getState().providerKind).toBe('on_device')
    expect(useEmbeddingStatusStore.getState().status).not.toBe('needs_consent')
  })

  // ── on-device model download (Phase 4 Task 5) ───────────────────────────

  it('a model-download-progress update sets status downloading_model and downloadProgress', () => {
    useEmbeddingStatusStore.getState().setModelDownloadProgress('bge-m3', 42)
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('downloading_model')
    expect(s.downloadProgress).toBe(42)
    expect(s.downloadModelId).toBe('bge-m3')
  })

  it('downloading_model outranks an active indexing run', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setIndexingProgress(3, 10)
    expect(useEmbeddingStatusStore.getState().status).toBe('indexing')

    useEmbeddingStatusStore.getState().setModelDownloadProgress('bge-m3', 10)
    expect(useEmbeddingStatusStore.getState().status).toBe('downloading_model')
  })

  it('a progress tick of 100 clears isDownloadingModel', () => {
    useEmbeddingStatusStore.getState().setModelDownloadProgress('bge-m3', 50)
    expect(useEmbeddingStatusStore.getState().status).toBe('downloading_model')

    useEmbeddingStatusStore.getState().setModelDownloadProgress('bge-m3', 100)
    const s = useEmbeddingStatusStore.getState()
    expect(s.status).not.toBe('downloading_model')
    expect(s.downloadProgress).toBe(100)
  })

  it('a model-download-error sets status model_error and stops isDownloadingModel', () => {
    useEmbeddingStatusStore.getState().setModelDownloadProgress('bge-m3', 30)
    useEmbeddingStatusStore.getState().setModelDownloadError('bge-m3', 'network_unreachable')

    const s = useEmbeddingStatusStore.getState()
    expect(s.status).toBe('model_error')
    expect(s.modelError).toBe('network_unreachable')
    expect(s.isDownloadingModel).toBe(false)
  })

  it('a fresh download-progress event clears a prior model_error', () => {
    useEmbeddingStatusStore.getState().setModelDownloadError('bge-m3', 'network_unreachable')
    expect(useEmbeddingStatusStore.getState().status).toBe('model_error')

    useEmbeddingStatusStore.getState().setModelDownloadProgress('bge-m3', 10)
    const s = useEmbeddingStatusStore.getState()
    expect(s.modelError).toBeNull()
    expect(s.status).toBe('downloading_model')
  })

  it('a generic backfill error still outranks model_error', () => {
    useEmbeddingStatusStore.getState().setModelDownloadError('bge-m3', 'network_unreachable')
    useEmbeddingStatusStore.getState().setError('AI_PROVIDER_ERROR')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')
  })

  // ── needs_decision (embed sync decision modal) ───────────────────────────

  it('pending decision slot surfaces needs_decision', () => {
    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'entry',
        state: 'pending',
        reason: 'model_mismatch',
        localModelId: 'openai:text-embedding-3-small',
        peerModels: [{ modelId: 'ollama:nomic-embed-text', count: 3 }],
        pendingUnits: 3,
        needsModal: true,
      },
    ])
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_decision')
  })

  it('paused decision slot with needsModal still surfaces needs_decision', () => {
    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'memory',
        state: 'pause',
        reason: 'model_mismatch',
        localModelId: 'm',
        peerModels: [],
        pendingUnits: 0,
        needsModal: true,
      },
    ])
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_decision')
  })

  it('needs_decision outranks needs_consent and paused backfill', () => {
    useEmbeddingStatusStore.getState().setProviderKind('hosted')
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: false })
    useEmbeddingStatusStore.getState().setIndexingProgress(1, 5)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_consent')

    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'entry',
        state: 'pending',
        reason: 'missing_key',
        localModelId: null,
        peerModels: [],
        pendingUnits: 2,
        needsModal: true,
      },
    ])
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_decision')
  })

  it('error and model_error still outrank needs_decision', () => {
    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'entry',
        state: 'pending',
        reason: 'model_mismatch',
        localModelId: 'm',
        peerModels: [],
        pendingUnits: 1,
        needsModal: true,
      },
    ])
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_decision')

    useEmbeddingStatusStore.getState().setModelDownloadError('bge-m3', 'network_unreachable')
    expect(useEmbeddingStatusStore.getState().status).toBe('model_error')

    useEmbeddingStatusStore.getState().setError('AI_PROVIDER_ERROR')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')
  })

  it('clearing decision slots (needsModal false) drops needs_decision', () => {
    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'entry',
        state: 'pending',
        reason: 'model_mismatch',
        localModelId: 'm',
        peerModels: [],
        pendingUnits: 1,
        needsModal: true,
      },
    ])
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_decision')

    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'entry',
        state: 'reembed',
        reason: 'model_mismatch',
        localModelId: 'm',
        peerModels: [],
        pendingUnits: 0,
        needsModal: false,
      },
    ])
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  // ── stuck (paused/error job rows the worker cannot claim) ────────────────

  it('paused job rows with pending work and no active run derive stuck', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(3)
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')

    useEmbeddingStatusStore.getState().setJobStats({ paused: 3, error: 0 })
    expect(useEmbeddingStatusStore.getState().status).toBe('stuck')
  })

  it('error job rows stay waiting — the worker can still claim them', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(1)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 0, error: 1 })
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')
  })

  it('one leftover paused row plus a real queue stays waiting', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(5)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 1, error: 0 })
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')
  })

  it('user-paused flag outranks stuck', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(3)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 3, error: 0 })
    expect(useEmbeddingStatusStore.getState().status).toBe('stuck')

    useEmbeddingStatusStore.getState().setIndexingProgress(0, 3)
    useEmbeddingStatusStore.getState().setBackfillComplete(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('paused')
  })

  it('backgroundEnabled false plus leftover jobStats stays idle, not stuck', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: false, allowed: false })
    useEmbeddingStatusStore.getState().setPendingCount(3)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 3, error: 1 })
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('stuck does not fire while a run is actively indexing', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setJobStats({ paused: 1, error: 1 })
    useEmbeddingStatusStore.getState().setIndexingProgress(1, 4)
    expect(useEmbeddingStatusStore.getState().status).toBe('indexing')
  })

  it('pending work without paused or error job rows stays waiting', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(4)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 0, error: 0 })
    expect(useEmbeddingStatusStore.getState().status).toBe('waiting')
  })

  it('paused or error job rows with no pending work stay idle', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setJobStats({ paused: 2, error: 1 })
    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('error still outranks stuck', () => {
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })
    useEmbeddingStatusStore.getState().setPendingCount(2)
    useEmbeddingStatusStore.getState().setJobStats({ paused: 2, error: 0 })
    expect(useEmbeddingStatusStore.getState().status).toBe('stuck')

    useEmbeddingStatusStore.getState().setError('AI_PROVIDER_ERROR')
    expect(useEmbeddingStatusStore.getState().status).toBe('error')
  })

  it('setDecisionModalOpen toggles without changing status', () => {
    useEmbeddingStatusStore.getState().setDecisionSlots([
      {
        slot: 'entry',
        state: 'pending',
        reason: 'model_mismatch',
        localModelId: 'm',
        peerModels: [],
        pendingUnits: 1,
        needsModal: true,
      },
    ])
    expect(useEmbeddingStatusStore.getState().decisionModalOpen).toBe(false)

    useEmbeddingStatusStore.getState().setDecisionModalOpen(true)
    expect(useEmbeddingStatusStore.getState().decisionModalOpen).toBe(true)
    expect(useEmbeddingStatusStore.getState().status).toBe('needs_decision')

    useEmbeddingStatusStore.getState().setDecisionModalOpen(false)
    expect(useEmbeddingStatusStore.getState().decisionModalOpen).toBe(false)
  })
})
