import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetEmbeddingStatusStoreForTests } from '../stores/embeddingStatusStore'
import type {
  BackfillCompleteEvent,
  BackfillProgressEvent,
  ModelDownloadErrorEvent,
  ModelDownloadProgressEvent,
} from '../types/ai'
import {
  applyEmbeddingJobStats,
  endpointClassToProviderKind,
  useEmbeddingStatus,
} from './useEmbeddingStatus'

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
    getAiProviders: vi.fn(),
    getBackgroundIndexingSettings: vi.fn(),
    getEmbeddingIndexStats: vi.fn(),
    getEmbeddingJobStats: vi.fn(),
    getBackfillStatus: vi.fn(),
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
const fireModelChanged = () => {
  handlers['ai:backfill-model-changed']?.({ payload: {} })
}
const fireDownloadProgress = (payload: ModelDownloadProgressEvent) => {
  handlers['ai:model-download-progress']?.({ payload })
}
const fireDownloadError = (payload: ModelDownloadErrorEvent) => {
  handlers['ai:model-download-error']?.({ payload })
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  __resetEmbeddingStatusStoreForTests()
  vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue({
    enabled: false,
    hostedConsentAt: null,
    allowed: false,
  })
  vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
    model_id: null,
    indexed: 0,
    total: 0,
    pending: 0,
  })
  vi.mocked(tauri.getAiProviders).mockResolvedValue({
    generation: null,
    image: null,
    embedding: null,
  })
  vi.mocked(tauri.getBackfillStatus).mockResolvedValue({
    running: false,
    model_id: null,
    indexed: 0,
    total: 0,
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

describe('endpointClassToProviderKind', () => {
  it('maps remote to hosted', () => {
    expect(endpointClassToProviderKind('remote')).toBe('hosted')
  })

  it('maps local to local', () => {
    expect(endpointClassToProviderKind('local')).toBe('local')
  })

  it('maps on-device to on_device', () => {
    expect(endpointClassToProviderKind('on-device')).toBe('on_device')
  })

  it('falls back to unknown for subscription (chat-only CLI) and any other unmapped value', () => {
    expect(endpointClassToProviderKind('subscription')).toBe('unknown')
    expect(endpointClassToProviderKind(null)).toBe('unknown')
    expect(endpointClassToProviderKind(undefined)).toBe('unknown')
  })
})

describe('useEmbeddingStatus', () => {
  it('hydrates pendingCount and providerKind from the initial refresh', async () => {
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
      model_id: 'm',
      indexed: 2,
      total: 10,
      pending: 8,
    })
    vi.mocked(tauri.getAiProviders).mockResolvedValue({
      generation: null,
      image: null,
      embedding: {
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        endpointClass: 'remote',
        embeddingModel: 'text-embedding-3-small',
        hasApiKey: true,
      },
    })

    const { result } = renderHook(() => useEmbeddingStatus())

    await waitFor(() => expect(result.current.pendingCount).toBe(8))
    expect(result.current.providerKind).toBe('hosted')
  })

  it('updates pendingCount/status from ai:backfill-progress events', async () => {
    const { result } = renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))

    act(() => {
      fireProgress({ model_id: 'm', indexed: 3, total: 10, current_entry_id: 'e1' })
    })

    expect(result.current.pendingCount).toBe(7)
    expect(result.current.status).toBe('indexing')
  })

  it('re-refreshes settings/stats/providers on ai:backfill-complete', async () => {
    renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))

    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
      model_id: 'm',
      indexed: 10,
      total: 10,
      pending: 0,
    })

    act(() => {
      fireComplete({ model_id: 'm', indexed: 10, total: 10, cancelled: false })
    })

    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(tauri.getAiProviders).toHaveBeenCalledTimes(2))
  })

  // Regression: Resume on an already-drained index spawns the worker but
  // emits no progress/completion event, so `refresh` reading a running
  // backfill status is the only thing that clears the stuck "Paused" label.
  it('clears a stuck paused status once refresh sees the worker running', async () => {
    const { result } = renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getBackfillStatus).toHaveBeenCalledTimes(1))

    act(() => {
      fireComplete({ model_id: 'm', indexed: 10, total: 10, cancelled: true })
    })
    await waitFor(() => expect(result.current.status).toBe('paused'))

    vi.mocked(tauri.getBackfillStatus).mockResolvedValue({
      running: true,
      model_id: 'm',
      indexed: 0,
      total: 10,
    })
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.status).toBe('idle')
  })

  it('re-refreshes settings/stats/providers on ai:backfill-model-changed', async () => {
    renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getAiProviders).toHaveBeenCalledTimes(1))

    act(() => {
      fireModelChanged()
    })

    await waitFor(() => expect(tauri.getAiProviders).toHaveBeenCalledTimes(2))
  })

  it('parses the stable error code from ai:backfill-error, stripping the detail suffix', async () => {
    const { result } = renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))

    act(() => {
      fireError({ error: 'AI_PROVIDER_ERROR: embedding provider returned empty batch' })
    })

    expect(result.current.lastError).toBe('AI_PROVIDER_ERROR')
    expect(result.current.status).toBe('error')
  })

  it('falls back to AI_BACKFILL_FAILED when the error payload is empty', async () => {
    const { result } = renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))

    act(() => {
      fireError({})
    })

    expect(result.current.lastError).toBe('AI_BACKFILL_FAILED')
  })

  it('subscribes to all six backfill/download events and unlistens each on unmount', async () => {
    const { unmount } = renderHook(() => useEmbeddingStatus())

    await waitFor(() =>
      expect(Object.keys(handlers).sort()).toEqual(
        [
          'ai:backfill-complete',
          'ai:backfill-error',
          'ai:backfill-model-changed',
          'ai:backfill-progress',
          'ai:model-download-error',
          'ai:model-download-progress',
        ].sort(),
      ),
    )

    unmount()

    // The mocked `listen` unlisten fn deletes its own entry — an empty
    // `handlers` map after unmount proves every unlisten fn actually ran.
    expect(Object.keys(handlers)).toEqual([])
  })

  it('updates downloadProgress/status from ai:model-download-progress events', async () => {
    const { result } = renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))

    act(() => {
      fireDownloadProgress({ model_id: 'bge-m3', progress: 42 })
    })

    expect(result.current.downloadProgress).toBe(42)
    expect(result.current.downloadModelId).toBe('bge-m3')
    expect(result.current.status).toBe('downloading_model')
  })

  it('updates modelError/status from ai:model-download-error events', async () => {
    const { result } = renderHook(() => useEmbeddingStatus())
    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))

    act(() => {
      fireDownloadError({ model_id: 'bge-m3', error: 'network_unreachable' })
    })

    expect(result.current.modelError).toBe('network_unreachable')
    expect(result.current.status).toBe('model_error')
  })

  // Regression: the web preview's invoke router returns `null` for
  // unhandled commands (see web/mocks/invokeRouter.ts). refresh must
  // tolerate null payloads from all three commands without throwing —
  // before the null-guards this crashed at `settings.enabled`.
  it('calls getEmbeddingJobStats with model_id and derives stuck when every pending job is paused', async () => {
    vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue({
      enabled: true,
      hostedConsentAt: null,
      allowed: true,
    })
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
      model_id: 'embed-m',
      indexed: 0,
      total: 2,
      pending: 2,
    })
    vi.mocked(tauri.getEmbeddingJobStats).mockResolvedValue({
      pending: 0,
      in_progress: 0,
      indexed: 0,
      skipped: 0,
      error: 0,
      paused: 2,
    })

    const { result } = renderHook(() => useEmbeddingStatus())

    await waitFor(() => expect(tauri.getEmbeddingJobStats).toHaveBeenCalledWith('embed-m'))
    expect(result.current.status).toBe('stuck')
  })

  it('does not derive stuck from error-only job rows the worker can still claim', async () => {
    vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue({
      enabled: true,
      hostedConsentAt: null,
      allowed: true,
    })
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue({
      model_id: 'embed-m',
      indexed: 0,
      total: 2,
      pending: 2,
    })
    vi.mocked(tauri.getEmbeddingJobStats).mockResolvedValue({
      pending: 0,
      in_progress: 0,
      indexed: 0,
      skipped: 0,
      error: 2,
      paused: 0,
    })

    const { result } = renderHook(() => useEmbeddingStatus())

    await waitFor(() => expect(tauri.getEmbeddingJobStats).toHaveBeenCalledWith('embed-m'))
    expect(result.current.status).toBe('waiting')
  })

  it('clears leftover job counts when model_id is null', async () => {
    const { useEmbeddingStatusStore } = await import('../stores/embeddingStatusStore')
    useEmbeddingStatusStore.getState().setJobStats({ paused: 4, error: 1 })

    renderHook(() => useEmbeddingStatus())

    await waitFor(() => expect(tauri.getEmbeddingIndexStats).toHaveBeenCalledTimes(1))
    expect(tauri.getEmbeddingJobStats).not.toHaveBeenCalled()
    expect(useEmbeddingStatusStore.getState().jobStats).toEqual({ paused: 0, error: 0 })
  })

  it('clears jobStats when getEmbeddingJobStats fails so a stale stuck cannot linger', async () => {
    const { useEmbeddingStatusStore } = await import('../stores/embeddingStatusStore')
    useEmbeddingStatusStore.getState().setJobStats({ paused: 3, error: 1 })
    vi.mocked(tauri.getEmbeddingJobStats).mockRejectedValue(new Error('stats down'))

    await applyEmbeddingJobStats('embed-m')

    expect(useEmbeddingStatusStore.getState().jobStats).toEqual({ paused: 0, error: 0 })
  })

  it('tolerates null payloads from getBackgroundIndexingSettings/getEmbeddingIndexStats/getAiProviders', async () => {
    vi.mocked(tauri.getBackgroundIndexingSettings).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof tauri.getBackgroundIndexingSettings>>,
    )
    vi.mocked(tauri.getEmbeddingIndexStats).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof tauri.getEmbeddingIndexStats>>,
    )
    vi.mocked(tauri.getAiProviders).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof tauri.getAiProviders>>,
    )

    const { result } = renderHook(() => useEmbeddingStatus())

    // refresh runs on mount; it must not throw and must settle to idle
    // defaults rather than propagating the null.
    await waitFor(() => expect(tauri.getBackgroundIndexingSettings).toHaveBeenCalledTimes(1))
    expect(result.current.pendingCount).toBe(0)
    expect(result.current.providerKind).toBe('unknown')
  })
})
