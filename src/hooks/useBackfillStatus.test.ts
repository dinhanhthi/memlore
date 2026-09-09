import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEmbeddingStatusStoreForTests,
  useEmbeddingStatusStore,
} from '../stores/embeddingStatusStore'
import type {
  BackfillCompleteEvent,
  BackfillModelChangedEvent,
  BackfillProgressEvent,
  BackfillStatus,
} from '../types/ai'
import { needsHostedConsent, useBackfillStatus } from './useBackfillStatus'

type Handler = (event: { payload: unknown }) => void
const handlers: Record<string, Handler> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    return () => {
      delete handlers[name]
    }
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    getBackfillStatus: vi.fn(),
    getEmbeddingIndexStats: vi.fn(),
    getEmbeddingJobStats: vi.fn(),
    startBackfill: vi.fn(),
    pauseBackfill: vi.fn(),
    getBackgroundIndexingSettings: vi.fn(),
    setBackgroundIndexingEnabled: vi.fn(),
    acceptBackgroundIndexingHostedConsent: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'

const fireProgress = (payload: BackfillProgressEvent) => {
  handlers['ai:backfill-progress']?.({ payload })
}
const fireComplete = (payload: BackfillCompleteEvent) => {
  handlers['ai:backfill-complete']?.({ payload })
}
const fireError = (payload: { error?: string }) => {
  handlers['ai:backfill-error']?.({ payload })
}
const fireModelChanged = (payload: BackfillModelChangedEvent) => {
  handlers['ai:backfill-model-changed']?.({ payload })
}

const idle: BackfillStatus = { running: false, model_id: null, indexed: 0, total: 0 }

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  __resetEmbeddingStatusStoreForTests()
  vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
    model_id: null,
    indexed: 0,
    total: 0,
    pending: 0,
  })
  vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue({
    enabled: false,
    hostedConsentAt: null,
    allowed: false,
  })
  vi.mocked(tauri.getEmbeddingJobStats).mockResolvedValue({
    pending: 0,
    in_progress: 0,
    indexed: 0,
    skipped: 0,
    error: 0,
    paused: 0,
  })
})

describe('useBackfillStatus', () => {
  it('hydrates initial status from get_backfill_status', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue({
      running: true,
      model_id: 'embedding-stub-768',
      indexed: 3,
      total: 10,
    })

    const { result } = renderHook(() => useBackfillStatus())

    await waitFor(() => expect(result.current.status.running).toBe(true))
    expect(result.current.status.indexed).toBe(3)
    expect(result.current.status.total).toBe(10)
  })

  it('updates status from ai:backfill-progress events', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      fireProgress({
        model_id: 'm',
        indexed: 1,
        total: 5,
        current_entry_id: 'e1',
      })
    })

    expect(result.current.status).toEqual({
      running: true,
      model_id: 'm',
      indexed: 1,
      total: 5,
    })
    expect(result.current.currentEntryId).toBe('e1')
  })

  it('resets to idle on ai:backfill-complete and exposes lastCompletion', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      fireProgress({ model_id: 'm', indexed: 5, total: 5, current_entry_id: 'e5' })
    })
    expect(result.current.status.running).toBe(true)

    act(() => {
      fireComplete({ model_id: 'm', indexed: 5, total: 5, cancelled: false })
    })

    expect(result.current.status).toEqual(idle)
    expect(result.current.currentEntryId).toBeNull()
    expect(result.current.lastCompletion).toEqual({
      model_id: 'm',
      indexed: 5,
      total: 5,
      cancelled: false,
    })
  })

  it('start() invokes the Tauri command and seeds the running status', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.startBackfill).mockResolvedValue({
      running: true,
      model_id: 'm',
      indexed: 0,
      total: 7,
    })

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.start()
    })

    expect(tauri.startBackfill).toHaveBeenCalledTimes(1)
    expect(result.current.status.total).toBe(7)
    expect(result.current.status.running).toBe(true)
  })

  // Regression: progress only fires after each embed finishes, so Index now
  // used to leave the status row on "Waiting for edits to settle" for the
  // whole provider round-trip. start() must flip the shared store to
  // indexing as soon as requeued pending work remains.
  it('start() with pending work optimistically begins indexing in the shared store', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.startBackfill).mockResolvedValue({
      running: true,
      model_id: 'm',
      indexed: 0,
      total: 1,
    })
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
      model_id: 'm',
      indexed: 0,
      total: 1,
      pending: 1,
    })
    useEmbeddingStatusStore.getState().setBackgroundSettings({ enabled: true, allowed: true })

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.start()
    })

    const store = useEmbeddingStatusStore.getState()
    expect(store.pendingCount).toBe(1)
    expect(store.status).toBe('indexing')
    expect(result.current.indexStats.pending).toBe(1)
  })

  it('start() with an empty queue does not begin indexing', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.startBackfill).mockResolvedValue({
      running: true,
      model_id: 'm',
      indexed: 0,
      total: 0,
    })
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
      model_id: 'm',
      indexed: 5,
      total: 5,
      pending: 0,
    })

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.start()
    })

    expect(useEmbeddingStatusStore.getState().status).toBe('idle')
  })

  it('pause() invokes the Tauri command', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.pauseBackfill).mockResolvedValue(undefined)

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.pause()
    })

    expect(tauri.pauseBackfill).toHaveBeenCalledTimes(1)
  })

  it('surfaces ai:backfill-model-changed as modelChangeNotice', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.modelChangeNotice).toBeNull()

    act(() => {
      fireModelChanged({
        model_id: 'openai:text-embedding-3-large',
        enqueued: 12,
        requires_consent: true,
      })
    })

    expect(result.current.modelChangeNotice).toEqual({
      model_id: 'openai:text-embedding-3-large',
      enqueued: 12,
      requires_consent: true,
    })
  })

  it('surfaces the code from ai:backfill-error, stripping the detail suffix', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      fireError({ error: 'AI_PROVIDER_ERROR: embedding provider returned empty batch' })
    })

    expect(result.current.error).toBe('AI_PROVIDER_ERROR')
  })

  it('falls back to AI_BACKFILL_FAILED when the error payload is empty', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      fireError({})
    })

    expect(result.current.error).toBe('AI_BACKFILL_FAILED')
  })

  it('keeps the backfill error when the run guard emits completion right after it', async () => {
    // The regression path: a mid-loop embed failure emits ai:backfill-error,
    // then the guard emits ai:backfill-complete with cancelled:false. The
    // completion must NOT wipe the error, or BackfillRow reads "all done".
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      fireError({ error: 'AI_PROVIDER_ERROR: boom' })
      fireComplete({ model_id: 'm', indexed: 0, total: 7, cancelled: false })
    })

    expect(result.current.error).toBe('AI_PROVIDER_ERROR')
    expect(result.current.lastCompletion?.cancelled).toBe(false)
  })

  it('start() clears a prior backfill error before the next run', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.startBackfill).mockResolvedValue({
      running: true,
      model_id: 'm',
      indexed: 0,
      total: 7,
    })
    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      fireError({ error: 'AI_PROVIDER_ERROR: boom' })
    })
    expect(result.current.error).toBe('AI_PROVIDER_ERROR')

    await act(async () => {
      await result.current.start()
    })

    expect(result.current.error).toBeNull()
  })

  it('captures error when start() rejects', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.startBackfill).mockRejectedValue('AI_BACKFILL_ALREADY_RUNNING')

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.start().catch(() => {})
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toContain('AI_BACKFILL_ALREADY_RUNNING')
  })

  it('hydrates the background toggle + hosted-consent snapshot on mount', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue({
      enabled: true,
      hostedConsentAt: 1_700_000_000,
      allowed: true,
    })

    const { result } = renderHook(() => useBackfillStatus())

    await waitFor(() => expect(result.current.backgroundEnabled).toBe(true))
    expect(result.current.hostedConsentAt).toBe(1_700_000_000)
  })

  it('setBackgroundEnabled() invokes the Tauri command and updates state', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.setBackgroundIndexingEnabled).mockResolvedValue(undefined)

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setBackgroundEnabled(true)
    })

    expect(tauri.setBackgroundIndexingEnabled).toHaveBeenCalledWith(true)
    expect(result.current.backgroundEnabled).toBe(true)
  })

  it('setBackgroundEnabled() surfaces an error and leaves state unchanged when the command rejects', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.setBackgroundIndexingEnabled).mockRejectedValue('AI_NOT_CONFIGURED')

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setBackgroundEnabled(true).catch(() => {})
    })

    expect(result.current.backgroundEnabled).toBe(false)
    expect(result.current.error).toContain('AI_NOT_CONFIGURED')
  })

  it('acceptHostedConsent() invokes the Tauri command and stores the returned timestamp', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.acceptBackgroundIndexingHostedConsent).mockResolvedValue(1_700_000_500)

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hostedConsentAt).toBeNull()

    await act(async () => {
      await result.current.acceptHostedConsent()
    })

    expect(tauri.acceptBackgroundIndexingHostedConsent).toHaveBeenCalledTimes(1)
    expect(result.current.hostedConsentAt).toBe(1_700_000_500)
  })

  it('re-fetches the background settings snapshot on ai:backfill-model-changed', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(idle)
    vi.mocked(tauri.getBackgroundIndexingSettings)
      .mockResolvedValueOnce({ enabled: true, hostedConsentAt: 111, allowed: true })
      .mockResolvedValueOnce({ enabled: true, hostedConsentAt: null, allowed: false })

    const { result } = renderHook(() => useBackfillStatus())
    await waitFor(() => expect(result.current.hostedConsentAt).toBe(111))

    act(() => {
      fireModelChanged({
        model_id: 'openai:text-embedding-3-large',
        enqueued: 4,
        requires_consent: true,
      })
    })

    await waitFor(() => expect(result.current.hostedConsentAt).toBeNull())
  })

  // Regression: the web preview's invoke router returns `null` for
  // unhandled commands (see web/mocks/invokeRouter.ts). The mount-time
  // hydration Promise.all and the refresh callbacks must tolerate null
  // payloads from all three commands without throwing — before the
  // null-guards this crashed consumers reading `.indexed` / `.enabled`.
  it('tolerates null payloads from the backfill/embedding commands on mount', async () => {
    vi.mocked(tauri.getBackfillStatus).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof tauri.getBackfillStatus>>,
    )
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof tauri.getEmbeddingIndexStats>>,
    )
    vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof tauri.getBackgroundIndexingSettings>>,
    )

    const { result } = renderHook(() => useBackfillStatus())

    // Hydration must settle to idle defaults rather than propagating null.
    await waitFor(() => expect(tauri.getBackfillStatus).toHaveBeenCalledTimes(1))
    expect(result.current.indexStats.indexed).toBe(0)
    expect(result.current.status).toEqual(idle)
    expect(result.current.backgroundEnabled).toBe(false)
    expect(result.current.hostedConsentAt).toBeNull()
  })
})

describe('needsHostedConsent', () => {
  it('requires consent only for a hosted provider with no recorded acceptance', () => {
    expect(needsHostedConsent('hosted', null)).toBe(true)
    expect(needsHostedConsent('hosted', 1_700_000_000)).toBe(false)
    expect(needsHostedConsent('local', null)).toBe(false)
    expect(needsHostedConsent('on_device', null)).toBe(false)
    expect(needsHostedConsent('unknown', null)).toBe(false)
  })
})
