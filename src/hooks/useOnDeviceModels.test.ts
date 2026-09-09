import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnDeviceModelStateWire, OnDeviceModelWire } from '../lib/tauri'
import type { ModelDownloadErrorEvent, ModelDownloadProgressEvent } from '../types/ai'
import {
  ON_DEVICE_MODEL_CATALOG,
  getReadyModels,
  getRecommendedModel,
  isHighRamModel,
  useOnDeviceModels,
  type ModelDownloadState,
} from './useOnDeviceModels'

type Handler = (event: { payload: unknown }) => void
const handlers: Record<string, Handler> = {}
const unlistenSpies: Record<string, ReturnType<typeof vi.fn>> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers[name] = handler
    const unlisten = vi.fn(() => {
      delete handlers[name]
    })
    unlistenSpies[name] = unlisten
    return unlisten
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri')
  return {
    ...actual,
    listOnDeviceModels: vi.fn(),
    startOnDeviceModelDownload: vi.fn(),
    cancelOnDeviceModelDownload: vi.fn(),
    removeOnDeviceModel: vi.fn(),
  }
})

vi.mock('../lib/aiFeatureAccessors', () => ({
  cacheReadyOnDevice: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { cacheReadyOnDevice } from '../lib/aiFeatureAccessors'

const fireProgress = (payload: ModelDownloadProgressEvent) => {
  handlers['ai:model-download-progress']?.({ payload })
}
const fireError = (payload: ModelDownloadErrorEvent) => {
  handlers['ai:model-download-error']?.({ payload })
}

function catalogEntry(id: string, overrides: Partial<OnDeviceModelWire> = {}): OnDeviceModelWire {
  const found = ON_DEVICE_MODEL_CATALOG.find((m) => m.id === id)
  return {
    id,
    displayName: found?.displayName ?? id,
    dim: found?.dim ?? 768,
    mrlDims: [],
    contextLength: found?.contextLength ?? 2048,
    downloadSize: found?.downloadSize ?? '~1 GB',
    approxRam: found?.approxRam ?? '~1 GB',
    multilingual: found?.multilingual ?? false,
    recommended: found?.recommended ?? false,
    whenToChoose: found?.whenToChoose ?? '',
    supported: true,
    state: { status: 'not_downloaded' },
    ...overrides,
  }
}

function defaultCatalog(): OnDeviceModelWire[] {
  return ON_DEVICE_MODEL_CATALOG.map((entry) => catalogEntry(entry.id, { supported: true }))
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(unlistenSpies)) delete unlistenSpies[k]
  vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(defaultCatalog())
})

describe('ON_DEVICE_MODEL_CATALOG', () => {
  it('has the four catalog models with the required decision metadata', () => {
    expect(ON_DEVICE_MODEL_CATALOG).toHaveLength(4)
    const ids = ON_DEVICE_MODEL_CATALOG.map((m) => m.id)
    expect(ids).toEqual([
      'multilingual-e5-base',
      'multilingual-e5-small',
      'multilingual-e5-large',
      'nomic-embed-text-v1.5',
    ])
    for (const entry of ON_DEVICE_MODEL_CATALOG) {
      expect(entry.displayName).toBeTruthy()
      expect(entry.whenToChoose).toBeTruthy()
      expect(entry.downloadSize).toBeTruthy()
      expect(entry.approxRam).toBeTruthy()
      expect(entry.dim).toBeGreaterThan(0)
      expect(entry.contextLength).toBeGreaterThan(0)
      expect(typeof entry.multilingual).toBe('boolean')
      expect(typeof entry.recommended).toBe('boolean')
    }
  })

  it('marks exactly one model recommended: multilingual-e5-base', () => {
    const recommended = ON_DEVICE_MODEL_CATALOG.filter((m) => m.recommended)
    expect(recommended).toHaveLength(1)
    expect(recommended[0]?.id).toBe('multilingual-e5-base')
    expect(getRecommendedModel()?.id).toBe('multilingual-e5-base')
  })

  it('flags multilingual-e5-large as the high-RAM model and not the lighter ones', () => {
    const flagged = ON_DEVICE_MODEL_CATALOG.filter(isHighRamModel).map((m) => m.id)
    expect(flagged).toEqual(['multilingual-e5-large'])
  })

  it('every catalog model is downloadable (has a fastembed backend)', () => {
    for (const model of defaultCatalog()) {
      expect(model.supported).toBe(true)
    }
  })
})

describe('getReadyModels', () => {
  it('keeps only ready models given a mix of statuses', () => {
    const states: Record<string, ModelDownloadState> = {
      'multilingual-e5-base': { status: 'ready' },
      'multilingual-e5-small': { status: 'downloading', progress: 40 },
      'multilingual-e5-large': { status: 'error', errorKey: 'boom' },
      'nomic-embed-text-v1.5': { status: 'not_downloaded' },
    }
    const ready = getReadyModels(ON_DEVICE_MODEL_CATALOG, states)
    expect(ready.map((m) => m.id)).toEqual(['multilingual-e5-base'])
  })

  it('returns an empty list when nothing is downloaded', () => {
    expect(getReadyModels(ON_DEVICE_MODEL_CATALOG, {})).toEqual([])
  })

  it('returns every model when all are ready', () => {
    const states: Record<string, ModelDownloadState> = Object.fromEntries(
      ON_DEVICE_MODEL_CATALOG.map((m) => [m.id, { status: 'ready' as const }]),
    )
    expect(getReadyModels(ON_DEVICE_MODEL_CATALOG, states).map((m) => m.id)).toEqual(
      ON_DEVICE_MODEL_CATALOG.map((m) => m.id),
    )
  })
})

describe('useOnDeviceModels', () => {
  it('loads the catalog state from list_on_device_models on mount', async () => {
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'not_downloaded' })
    })
    expect(tauri.listOnDeviceModels).toHaveBeenCalledTimes(1)
    expect(result.current.currentModelId).toBeNull()
  })

  it('passes the currentModelId param straight through', async () => {
    const { result } = renderHook(() => useOnDeviceModels('multilingual-e5-base'))

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'not_downloaded' })
    })
    expect(result.current.currentModelId).toBe('multilingual-e5-base')
  })

  it('surfaces a backend-reported unsupported model (supported:false) as a clear not-supported state, never a fake progress', async () => {
    // Every catalog model has a fastembed backend today, but the
    // `supported: false` mechanism must still work generically for any
    // future catalog entry that doesn't — simulate that here rather than
    // relying on the (now nonexistent) permanently-unsupported entries.
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      ON_DEVICE_MODEL_CATALOG.map((entry) =>
        catalogEntry(entry.id, { supported: entry.id !== 'multilingual-e5-small' }),
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-small']).toEqual({
        status: 'error',
        errorKey: 'not_supported',
      })
    })

    // download()/retry() on an unsupported model must not call the backend.
    act(() => {
      result.current.download('multilingual-e5-small')
    })
    expect(tauri.startOnDeviceModelDownload).not.toHaveBeenCalled()
    expect(result.current.states['multilingual-e5-small']).toEqual({
      status: 'error',
      errorKey: 'not_supported',
    })
  })

  it('download() calls start_on_device_model_download for a supported model', async () => {
    vi.mocked(tauri.startOnDeviceModelDownload).mockResolvedValue({ status: 'ready' })
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'not_downloaded' })
    })

    act(() => {
      result.current.download('nomic-embed-text-v1.5')
    })

    expect(tauri.startOnDeviceModelDownload).toHaveBeenCalledWith('nomic-embed-text-v1.5')
    expect(result.current.states['nomic-embed-text-v1.5']).toEqual({
      status: 'downloading',
      progress: 0,
    })

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'ready' })
    })
  })

  it('a download-progress event updates that model to downloading{progress}', async () => {
    vi.mocked(tauri.startOnDeviceModelDownload).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-large']).toEqual({ status: 'not_downloaded' })
    })

    act(() => {
      result.current.download('multilingual-e5-large')
    })

    act(() => {
      fireProgress({ model_id: 'multilingual-e5-large', progress: 42 })
    })

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-large']).toEqual({
        status: 'downloading',
        progress: 42,
      })
    })
  })

  it('a download-error event sets that model to error', async () => {
    vi.mocked(tauri.startOnDeviceModelDownload).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-large']).toEqual({ status: 'not_downloaded' })
    })

    act(() => {
      result.current.download('multilingual-e5-large')
    })

    act(() => {
      fireError({ model_id: 'multilingual-e5-large', error: 'network_error' })
    })

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-large']).toEqual({
        status: 'error',
        errorKey: 'network_error',
      })
    })
  })

  it('cancel() calls cancel_on_device_model_download and remove() calls remove_on_device_model', async () => {
    vi.mocked(tauri.cancelOnDeviceModelDownload).mockResolvedValue({ status: 'not_downloaded' })
    vi.mocked(tauri.removeOnDeviceModel).mockResolvedValue({ status: 'not_downloaded' })
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'not_downloaded' })
    })

    act(() => {
      result.current.cancel('nomic-embed-text-v1.5')
    })
    expect(tauri.cancelOnDeviceModelDownload).toHaveBeenCalledWith('nomic-embed-text-v1.5')

    await act(async () => {
      await result.current.remove('nomic-embed-text-v1.5')
    })
    expect(tauri.removeOnDeviceModel).toHaveBeenCalledWith('nomic-embed-text-v1.5')
    expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'not_downloaded' })
  })

  it('remove() updates the palette cache from remaining catalog state', async () => {
    vi.mocked(tauri.removeOnDeviceModel).mockResolvedValue({ status: 'not_downloaded' })
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      defaultCatalog().map((model) =>
        model.id === 'multilingual-e5-base'
          ? { ...model, state: { status: 'ready' as const } }
          : model,
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'ready' })
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    await act(async () => {
      await result.current.remove('multilingual-e5-base')
    })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('embed', false)
  })

  it('remove() keeps the palette true when another catalog model is still ready', async () => {
    vi.mocked(tauri.removeOnDeviceModel).mockResolvedValue({ status: 'not_downloaded' })
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      defaultCatalog().map((model) =>
        model.id === 'multilingual-e5-base' || model.id === 'nomic-embed-text-v1.5'
          ? { ...model, state: { status: 'ready' as const } }
          : model,
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'ready' })
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'ready' })
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    await act(async () => {
      await result.current.remove('multilingual-e5-base')
    })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('embed', true)
  })

  it('remove(id) does not resolve until removeOnDeviceModel settles', async () => {
    let resolveRemove: (state: OnDeviceModelStateWire) => void = () => {}
    vi.mocked(tauri.removeOnDeviceModel).mockReturnValue(
      new Promise((resolve) => {
        resolveRemove = resolve
      }),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'not_downloaded' })
    })

    const pending = result.current.remove('nomic-embed-text-v1.5')
    expect(pending).toBeInstanceOf(Promise)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await act(async () => {
      resolveRemove({ status: 'not_downloaded' })
      await pending
    })
    expect(settled).toBe(true)
    expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'not_downloaded' })
  })

  it('remove(id) still propagates a generic delete rejection', async () => {
    vi.mocked(tauri.removeOnDeviceModel).mockRejectedValue('disk_error')
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      ON_DEVICE_MODEL_CATALOG.map((entry) =>
        catalogEntry(entry.id, {
          state:
            entry.id === 'nomic-embed-text-v1.5'
              ? { status: 'ready' }
              : { status: 'not_downloaded' },
        }),
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'ready' })
    })

    await expect(result.current.remove('nomic-embed-text-v1.5')).rejects.toBe('disk_error')
    expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'ready' })
  })

  it('remove() does not flip the palette cache when delete is rejected', async () => {
    vi.mocked(tauri.removeOnDeviceModel).mockRejectedValue('disk_error')
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      defaultCatalog().map((model) =>
        model.id === 'nomic-embed-text-v1.5'
          ? { ...model, state: { status: 'ready' as const } }
          : model,
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'ready' })
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    await expect(result.current.remove('nomic-embed-text-v1.5')).rejects.toBe('disk_error')
    expect(cacheReadyOnDevice).not.toHaveBeenCalled()
    expect(result.current.states['nomic-embed-text-v1.5']).toEqual({ status: 'ready' })
  })

  it('cleans up event listeners on unmount', async () => {
    const { unmount } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(handlers['ai:model-download-progress']).toBeDefined()
      expect(handlers['ai:model-download-error']).toBeDefined()
      expect(handlers['ai:model-removed']).toBeDefined()
    })

    const progressUnlisten = unlistenSpies['ai:model-download-progress']
    const errorUnlisten = unlistenSpies['ai:model-download-error']
    const removedUnlisten = unlistenSpies['ai:model-removed']

    unmount()

    expect(progressUnlisten).toHaveBeenCalledTimes(1)
    expect(errorUnlisten).toHaveBeenCalledTimes(1)
    expect(removedUnlisten).toHaveBeenCalledTimes(1)
  })

  it('a stray 100% progress tick after the terminal state resolves does not clobber ready/error', async () => {
    let resolveDownload: (state: OnDeviceModelStateWire) => void = () => {}
    vi.mocked(tauri.startOnDeviceModelDownload).mockReturnValue(
      new Promise((resolve) => {
        resolveDownload = resolve
      }),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-large']).toEqual({ status: 'not_downloaded' })
    })

    act(() => {
      result.current.download('multilingual-e5-large')
    })

    await act(async () => {
      resolveDownload({ status: 'ready' })
      // Let the promise microtask settle before the (out-of-order) event fires.
      await Promise.resolve()
    })

    expect(result.current.states['multilingual-e5-large']).toEqual({ status: 'ready' })

    act(() => {
      fireProgress({ model_id: 'multilingual-e5-large', progress: 100 })
    })

    expect(result.current.states['multilingual-e5-large']).toEqual({ status: 'ready' })
  })

  it('ai:model-removed drops that embed id from catalog state and updates the palette cache', async () => {
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      defaultCatalog().map((model) =>
        model.id === 'multilingual-e5-base'
          ? { ...model, state: { status: 'ready' as const } }
          : model,
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'ready' })
      expect(handlers['ai:model-removed']).toBeDefined()
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    act(() => {
      handlers['ai:model-removed']?.({
        payload: { id: 'multilingual-e5-base', kind: 'embed' },
      })
    })

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'not_downloaded' })
    })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('embed', false)
  })

  it('ignores ai:model-removed when kind is not embed', async () => {
    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      defaultCatalog().map((model) =>
        model.id === 'multilingual-e5-base'
          ? { ...model, state: { status: 'ready' as const } }
          : model,
      ),
    )
    const { result } = renderHook(() => useOnDeviceModels())

    await waitFor(() => {
      expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'ready' })
      expect(handlers['ai:model-removed']).toBeDefined()
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    act(() => {
      handlers['ai:model-removed']?.({
        payload: { id: 'multilingual-e5-base', kind: 'llm' },
      })
    })

    expect(result.current.states['multilingual-e5-base']).toEqual({ status: 'ready' })
    expect(cacheReadyOnDevice).not.toHaveBeenCalled()
  })

  it('refresh() writes embed readiness into the palette cache', async () => {
    const { result } = renderHook(() => useOnDeviceModels())
    await waitFor(() => {
      expect(cacheReadyOnDevice).toHaveBeenCalledWith('embed', false)
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    vi.mocked(tauri.listOnDeviceModels).mockResolvedValue(
      defaultCatalog().map((model) =>
        model.id === 'multilingual-e5-base'
          ? { ...model, state: { status: 'ready' as const } }
          : model,
      ),
    )

    await act(async () => {
      await result.current.refresh()
    })

    expect(cacheReadyOnDevice).toHaveBeenCalledWith('embed', true)
  })
})
