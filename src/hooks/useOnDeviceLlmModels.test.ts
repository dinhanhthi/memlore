/**
 * Tests for `useOnDeviceLlmModels` (Phase 5 Task 1).
 *
 * Mocking follows the project rule: never call the real Tauri backend.
 * `@tauri-apps/api/event` `listen` and the `../lib/tauri` IPC wrappers
 * are mocked; we drive them via the `handlers` / wrapper spies. The
 * pattern mirrors `useOnDeviceModels.test.ts` exactly.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { OnDeviceLlmModelWire, OnDeviceLlmServerStateWire } from '../lib/tauri'
import {
  BINARY_PHASE_ID,
  ON_DEVICE_LLM_TERMS_ACCEPTED_AT,
  TERMS_NOT_ACCEPTED_CODE,
  TermsNotAcceptedError,
  getReadyLlmModels,
  useOnDeviceLlmModels,
  type LlmModelState,
  type OnDeviceLlmCatalogEntry,
  type OnDeviceLlmDownloadProgressEvent,
  type OnDeviceLlmServerStatusEvent,
} from './useOnDeviceLlmModels'

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
    listOnDeviceLlmModels: vi.fn(),
    getOnDeviceLlmServerStatus: vi.fn(),
    downloadOnDeviceLlmModel: vi.fn(),
    cancelOnDeviceLlmDownload: vi.fn(),
    deleteOnDeviceLlmModel: vi.fn(),
    onDeviceLlmBinaryStatus: vi.fn(),
    deleteOnDeviceLlmBinary: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
  }
})

vi.mock('../lib/aiFeatureAccessors', () => ({
  cacheReadyOnDevice: vi.fn(),
}))

import * as tauri from '../lib/tauri'
import { cacheReadyOnDevice } from '../lib/aiFeatureAccessors'

const PROGRESS_EVENT = 'on-device-llm:download-progress'
const SERVER_EVENT = 'on-device-llm:server-status'

const fireProgress = (payload: OnDeviceLlmDownloadProgressEvent) => {
  handlers[PROGRESS_EVENT]?.({ payload })
}
const fireServer = (payload: OnDeviceLlmServerStatusEvent) => {
  handlers[SERVER_EVENT]?.({ payload })
}

// NOTE: the wire is camelCase — it mirrors the backend `OnDeviceLlmModelInfo`
// (`#[serde(rename_all = "camelCase")]`). Mocking it snake_case (as an earlier
// version did) let the field-name-drift bug through: the hook read snake_case
// fields that arrive `undefined` at runtime, crashing the picker.
function catalogEntry(
  id: string,
  overrides: Partial<OnDeviceLlmModelWire> = {},
): OnDeviceLlmModelWire {
  return {
    id,
    displayName: id,
    downloadSizeBytes: 4_000_000_000,
    contextTokens: 8192,
    minRamGb: 8,
    recommended: false,
    multilingual: true,
    whenToChoose: '',
    termsUrl: '',
    requiresAcceptance: false,
    downloadState: { status: 'not_downloaded' },
    ...overrides,
  }
}

const GEMMA = (): OnDeviceLlmModelWire =>
  catalogEntry('gemma-4-e4b-it', { recommended: true, minRamGb: 8 })
const QWEN = (): OnDeviceLlmModelWire => catalogEntry('qwen-4-1.7b', { minRamGb: 4 })

function defaultCatalog(): OnDeviceLlmModelWire[] {
  return [GEMMA(), QWEN()]
}

const STOPPED: OnDeviceLlmServerStateWire = { state: 'stopped' }

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(unlistenSpies)) delete unlistenSpies[k]
  vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue(defaultCatalog())
  vi.mocked(tauri.getOnDeviceLlmServerStatus).mockResolvedValue(STOPPED)
  vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
    installed: false,
    size_bytes: 0,
  })
  vi.mocked(tauri.deleteOnDeviceLlmBinary).mockResolvedValue(undefined)
  vi.mocked(tauri.getSetting).mockResolvedValue(null)
  vi.mocked(tauri.setSetting).mockResolvedValue(undefined)
})

function llmCatalogEntry(
  id: string,
  overrides: Partial<OnDeviceLlmCatalogEntry> = {},
): OnDeviceLlmCatalogEntry {
  return {
    id,
    display_name: id,
    download_size_bytes: 4_000_000_000,
    context_tokens: 8192,
    min_ram_gb: 8,
    recommended: false,
    multilingual: true,
    when_to_choose: '',
    terms_url: '',
    requires_acceptance: false,
    ...overrides,
  }
}

const LLM_CATALOG: OnDeviceLlmCatalogEntry[] = [
  llmCatalogEntry('gemma-4-e4b-it', { recommended: true }),
  llmCatalogEntry('gemma-4-e2b-it'),
  llmCatalogEntry('gemma-4-12b-it', { min_ram_gb: 16 }),
]

describe('getReadyLlmModels', () => {
  it('keeps only ready models given a mix of statuses', () => {
    const states: Record<string, LlmModelState> = {
      'gemma-4-e4b-it': { status: 'ready' },
      'gemma-4-e2b-it': { status: 'downloading', progress: 60 },
      'gemma-4-12b-it': { status: 'error', code: 'boom' },
    }
    const ready = getReadyLlmModels(LLM_CATALOG, states)
    expect(ready.map((m) => m.id)).toEqual(['gemma-4-e4b-it'])
  })

  it('returns an empty list when nothing is downloaded', () => {
    expect(getReadyLlmModels(LLM_CATALOG, {})).toEqual([])
  })

  it('returns every model when all are ready', () => {
    const states: Record<string, LlmModelState> = Object.fromEntries(
      LLM_CATALOG.map((m) => [m.id, { status: 'ready' as const }]),
    )
    expect(getReadyLlmModels(LLM_CATALOG, states).map((m) => m.id)).toEqual(
      LLM_CATALOG.map((m) => m.id),
    )
  })

  it('ignores a ready key that is not in the catalog', () => {
    const states: Record<string, LlmModelState> = {
      'ghost-not-in-catalog': { status: 'ready' },
      'gemma-4-e4b-it': { status: 'not_downloaded' },
    }
    expect(getReadyLlmModels(LLM_CATALOG, states)).toEqual([])
  })
})

describe('useOnDeviceLlmModels', () => {
  it('hydrates catalog, states, and serverStatus from the backend on mount', async () => {
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
      catalogEntry('qwen-4-1.7b', {
        downloadState: { status: 'downloading', progress: 30 },
      }),
    ])
    vi.mocked(tauri.getOnDeviceLlmServerStatus).mockResolvedValue({
      state: 'ready',
      model_id: 'gemma-4-e4b-it',
      port: 12345,
    })

    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    expect(tauri.listOnDeviceLlmModels).toHaveBeenCalledTimes(1)
    expect(tauri.getOnDeviceLlmServerStatus).toHaveBeenCalledTimes(1)

    // Catalog is hydrated purely from the backend (no static copy).
    expect(result.current.catalog.map((m) => m.id)).toEqual(['gemma-4-e4b-it', 'qwen-4-1.7b'])
    expect(result.current.catalog[0]).toMatchObject({
      id: 'gemma-4-e4b-it',
      display_name: 'gemma-4-e4b-it',
      download_size_bytes: 4_000_000_000,
      context_tokens: 8192,
      min_ram_gb: 8,
      recommended: true,
      multilingual: true,
    })

    // Download states are derived from the joined download_state field.
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
    expect(result.current.states['qwen-4-1.7b']).toEqual({
      status: 'downloading',
      progress: 30,
    })

    // Server status is hydrated too.
    expect(result.current.serverStatus).toEqual({
      state: 'ready',
      model_id: 'gemma-4-e4b-it',
      port: 12345,
    })
  })

  it('a download-progress event updates the model state (status/progress)', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })

    act(() => {
      fireProgress({ id: 'gemma-4-e4b-it', state: 'downloading', progress: 55 })
    })

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({
        status: 'downloading',
        progress: 55,
      })
    })
  })

  it('a server-status event updates serverStatus', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.serverStatus).toEqual({ state: 'stopped' })
    })

    act(() => {
      fireServer({ state: 'starting' })
    })

    await waitFor(() => {
      expect(result.current.serverStatus).toEqual({ state: 'starting' })
    })

    act(() => {
      fireServer({ state: 'ready', model_id: 'gemma-4-e4b-it', port: 8888 })
    })

    await waitFor(() => {
      expect(result.current.serverStatus).toEqual({
        state: 'ready',
        model_id: 'gemma-4-e4b-it',
        port: 8888,
      })
    })
  })

  it('terminal-state defense: after ready, a late downloading event does not clobber it (model + server)', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })

    // Model: ready is terminal-ish — a late downloading must not overwrite.
    act(() => {
      fireProgress({ id: 'gemma-4-e4b-it', state: 'ready' })
    })
    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
    })

    act(() => {
      fireProgress({ id: 'gemma-4-e4b-it', state: 'downloading', progress: 99 })
    })
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })

    // Server: ready/failed are terminal-ish — a late starting must not overwrite.
    act(() => {
      fireServer({ state: 'ready', model_id: 'gemma-4-e4b-it', port: 1 })
    })
    await waitFor(() => {
      expect(result.current.serverStatus).toEqual({
        state: 'ready',
        model_id: 'gemma-4-e4b-it',
        port: 1,
      })
    })

    act(() => {
      fireServer({ state: 'starting' })
    })
    expect(result.current.serverStatus).toEqual({
      state: 'ready',
      model_id: 'gemma-4-e4b-it',
      port: 1,
    })

    // Same defense for failed: a late starting must not revive it.
    act(() => {
      fireServer({ state: 'failed', code: 'start_failed' })
    })
    await waitFor(() => {
      expect(result.current.serverStatus).toEqual({ state: 'failed', code: 'start_failed' })
    })

    act(() => {
      fireServer({ state: 'starting' })
    })
    expect(result.current.serverStatus).toEqual({ state: 'failed', code: 'start_failed' })

    // Model error is also terminal-ish.
    act(() => {
      fireProgress({ id: 'qwen-4-1.7b', state: 'error', code: 'network_error' })
    })
    await waitFor(() => {
      expect(result.current.states['qwen-4-1.7b']).toEqual({
        status: 'error',
        code: 'network_error',
      })
    })
    act(() => {
      fireProgress({ id: 'qwen-4-1.7b', state: 'downloading', progress: 10 })
    })
    expect(result.current.states['qwen-4-1.7b']).toEqual({
      status: 'error',
      code: 'network_error',
    })
  })

  it('a binary-phase error flips an in-flight model download to error (no stuck 0%)', async () => {
    vi.mocked(tauri.downloadOnDeviceLlmModel).mockResolvedValue(undefined)
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    // Optimistically start a model download (sets { downloading, 0 }).
    await act(async () => {
      await result.current.download('gemma-4-e4b-it')
    })
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'downloading', progress: 0 })

    // The binary phase (which runs first) fails → the model phase never runs.
    act(() => {
      fireProgress({
        id: BINARY_PHASE_ID,
        phase: 'binary',
        state: 'error',
        code: 'download_size_mismatch',
      })
    })

    await waitFor(() => {
      // Binary slot reflects the failure...
      expect(result.current.binaryState).toEqual({
        status: 'error',
        code: 'download_size_mismatch',
      })
      // ...and the stuck model download is now surfaced as an error too.
      expect(result.current.states['gemma-4-e4b-it']).toEqual({
        status: 'error',
        code: 'download_size_mismatch',
      })
    })
  })

  it('a download_cancelled error resets the model to not_downloaded (cancel is not a failure)', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })

    // Start downloading, then the backend reports a user-initiated cancel.
    act(() => {
      fireProgress({ id: 'gemma-4-e4b-it', state: 'downloading', progress: 40 })
    })
    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({
        status: 'downloading',
        progress: 40,
      })
    })

    act(() => {
      fireProgress({ id: 'gemma-4-e4b-it', state: 'error', code: 'download_cancelled' })
    })
    await waitFor(() => {
      // NOT { status: 'error' } — a cancel returns the row to a clean
      // Download state, no error line, no Retry.
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })
  })

  it('a binary download_cancelled does not turn in-flight models into errors', async () => {
    vi.mocked(tauri.downloadOnDeviceLlmModel).mockResolvedValue(undefined)
    const { result } = renderHook(() => useOnDeviceLlmModels())
    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    await act(async () => {
      await result.current.download('gemma-4-e4b-it')
    })
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'downloading', progress: 0 })

    act(() => {
      fireProgress({
        id: BINARY_PHASE_ID,
        phase: 'binary',
        state: 'error',
        code: 'download_cancelled',
      })
    })
    await waitFor(() => {
      expect(result.current.binaryState).toEqual({ status: 'not_downloaded' })
    })
    // The model must NOT be flipped to error by a cancel.
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'downloading', progress: 0 })
  })

  it('download(id) calls the downloadOnDeviceLlmModel wrapper', async () => {
    vi.mocked(tauri.downloadOnDeviceLlmModel).mockResolvedValue(undefined)
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    await act(async () => {
      await result.current.download('gemma-4-e4b-it')
    })

    expect(tauri.downloadOnDeviceLlmModel).toHaveBeenCalledWith('gemma-4-e4b-it')
  })

  it('cancelDownload(id) calls the cancelOnDeviceLlmDownload wrapper', async () => {
    vi.mocked(tauri.cancelOnDeviceLlmDownload).mockResolvedValue(undefined)
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    await act(async () => {
      await result.current.cancelDownload('gemma-4-e4b-it')
    })

    expect(tauri.cancelOnDeviceLlmDownload).toHaveBeenCalledWith('gemma-4-e4b-it')
  })

  it('remove(id) resolves and marks the model not_downloaded even if it was in use', async () => {
    vi.mocked(tauri.deleteOnDeviceLlmModel).mockResolvedValue(undefined)
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
      catalogEntry('qwen-4-1.7b'),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
    })

    await act(async () => {
      await result.current.remove('gemma-4-e4b-it')
    })

    expect(tauri.deleteOnDeviceLlmModel).toHaveBeenCalledWith('gemma-4-e4b-it')
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', false)
  })

  it('remove() keeps the palette true when another catalog model is still ready', async () => {
    vi.mocked(tauri.deleteOnDeviceLlmModel).mockResolvedValue(undefined)
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
      catalogEntry('qwen-4-1.7b', { downloadState: { status: 'ready' } }),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
      expect(result.current.states['qwen-4-1.7b']).toEqual({ status: 'ready' })
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    await act(async () => {
      await result.current.remove('gemma-4-e4b-it')
    })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', true)
  })

  it('remove(id) still propagates a generic delete rejection', async () => {
    vi.mocked(tauri.deleteOnDeviceLlmModel).mockRejectedValue('disk_error')
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', { downloadState: { status: 'ready' } }),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
    })

    await expect(result.current.remove('gemma-4-e4b-it')).rejects.toBe('disk_error')
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
  })

  it('remove() does not flip the palette cache when delete is rejected', async () => {
    vi.mocked(tauri.deleteOnDeviceLlmModel).mockRejectedValue('disk_error')
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', { downloadState: { status: 'ready' } }),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    await expect(result.current.remove('gemma-4-e4b-it')).rejects.toBe('disk_error')
    expect(cacheReadyOnDevice).not.toHaveBeenCalled()
    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
  })

  it('hydrates binaryState as ready when onDeviceLlmBinaryStatus reports installed', async () => {
    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 123,
    })

    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.binaryState.status).toBe('ready')
    })
    expect(tauri.onDeviceLlmBinaryStatus).toHaveBeenCalled()
  })

  it('refresh() hydrates binaryState from onDeviceLlmBinaryStatus', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.binaryState).toEqual({ status: 'not_downloaded' })
    })

    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 123,
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.binaryState.status).toBe('ready')
  })

  it('removeBinary() calls deleteOnDeviceLlmBinary and sets binaryState to not_downloaded', async () => {
    vi.mocked(tauri.onDeviceLlmBinaryStatus).mockResolvedValue({
      installed: true,
      size_bytes: 123,
    })
    vi.mocked(tauri.deleteOnDeviceLlmBinary).mockResolvedValue(undefined)

    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.binaryState.status).toBe('ready')
    })

    await act(async () => {
      await result.current.removeBinary()
    })

    expect(tauri.deleteOnDeviceLlmBinary).toHaveBeenCalledTimes(1)
    expect(result.current.binaryState).toEqual({ status: 'not_downloaded' })
  })

  it('unmount unsubscribes both event listeners', async () => {
    const { unmount } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(handlers[PROGRESS_EVENT]).toBeDefined()
      expect(handlers[SERVER_EVENT]).toBeDefined()
      expect(handlers['ai:model-removed']).toBeDefined()
    })

    const progressUnlisten = unlistenSpies[PROGRESS_EVENT]
    const serverUnlisten = unlistenSpies[SERVER_EVENT]
    const removedUnlisten = unlistenSpies['ai:model-removed']

    unmount()

    expect(progressUnlisten).toHaveBeenCalledTimes(1)
    expect(serverUnlisten).toHaveBeenCalledTimes(1)
    expect(removedUnlisten).toHaveBeenCalledTimes(1)
  })

  it('does not leak the download-progress listener when unmounted before its listen() call resolves', async () => {
    // Reproduces the race: `subscribe()`'s first `await listen(...)` (the
    // download-progress subscription) is still pending when the component
    // unmounts. Cleanup runs immediately with an empty `unlisteners` array
    // (nothing to call yet). If `subscribe()` doesn't re-check `cancelled`
    // once the deferred `listen()` finally resolves, the returned unlisten
    // fn is silently dropped — a listener leak. Control the promise
    // ourselves so we can unmount strictly before it settles.
    let resolveProgressListen!: (fn: UnlistenFn) => void
    const progressUnlisten: UnlistenFn = vi.fn()

    vi.mocked(listen).mockImplementationOnce(
      (() =>
        new Promise<UnlistenFn>((resolve) => {
          resolveProgressListen = resolve
        })) as typeof listen,
    )

    const { unmount } = renderHook(() => useOnDeviceLlmModels())

    // Unmount while the deferred `listen()` call is still pending.
    unmount()

    // Now let the pending `listen()` resolve — post-fix, `subscribe()` must
    // notice `cancelled` and call the unlisten fn itself instead of pushing
    // it onto an array cleanup already walked.
    await act(async () => {
      resolveProgressListen(progressUnlisten)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(progressUnlisten).toHaveBeenCalledTimes(1)
  })

  it('refresh() re-hydrates catalog, states, and serverStatus', async () => {
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValueOnce(defaultCatalog())
    vi.mocked(tauri.getOnDeviceLlmServerStatus).mockResolvedValueOnce(STOPPED)

    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValueOnce([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
    ])
    vi.mocked(tauri.getOnDeviceLlmServerStatus).mockResolvedValueOnce({
      state: 'ready',
      model_id: 'gemma-4-e4b-it',
      port: 9999,
    })

    await act(async () => {
      await result.current.refresh()
    })

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(1)
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
      expect(result.current.serverStatus).toEqual({
        state: 'ready',
        model_id: 'gemma-4-e4b-it',
        port: 9999,
      })
    })
  })

  it('ai:model-removed drops that llm id from catalog state and updates the palette cache', async () => {
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
      catalogEntry('qwen-4-1.7b'),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
      expect(handlers['ai:model-removed']).toBeDefined()
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    act(() => {
      handlers['ai:model-removed']?.({
        payload: { id: 'gemma-4-e4b-it', kind: 'llm' },
      })
    })

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', false)
  })

  it('ai:model-removed keeps the palette true when another catalog model is ready', async () => {
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
      catalogEntry('qwen-4-1.7b', { downloadState: { status: 'ready' } }),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
      expect(result.current.states['qwen-4-1.7b']).toEqual({ status: 'ready' })
      expect(handlers['ai:model-removed']).toBeDefined()
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    act(() => {
      handlers['ai:model-removed']?.({
        payload: { id: 'gemma-4-e4b-it', kind: 'llm' },
      })
    })

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })
    expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', true)
  })

  it('ai:model-removed ignores a ready key that is not in the catalog', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
      expect(handlers['ai:model-removed']).toBeDefined()
    })

    act(() => {
      fireProgress({ id: 'ghost-not-in-catalog', phase: 'model', state: 'ready' })
    })
    await waitFor(() => {
      expect(result.current.states['ghost-not-in-catalog']).toEqual({ status: 'ready' })
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    act(() => {
      handlers['ai:model-removed']?.({
        payload: { id: 'gemma-4-e4b-it', kind: 'llm' },
      })
    })

    expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', false)
  })

  it('ignores ai:model-removed when kind is not llm', async () => {
    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
    ])
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
      expect(handlers['ai:model-removed']).toBeDefined()
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    act(() => {
      handlers['ai:model-removed']?.({
        payload: { id: 'gemma-4-e4b-it', kind: 'embed' },
      })
    })

    expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'ready' })
    expect(cacheReadyOnDevice).not.toHaveBeenCalled()
  })

  it('hydrate() writes llm readiness into the palette cache', async () => {
    renderHook(() => useOnDeviceLlmModels())
    await waitFor(() => {
      expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', false)
    })
  })

  it('refresh() writes llm readiness into the palette cache after a ready model appears', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())
    await waitFor(() => {
      expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', false)
    })
    vi.mocked(cacheReadyOnDevice).mockClear()

    vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValueOnce([
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        downloadState: { status: 'ready' },
      }),
    ])

    await act(async () => {
      await result.current.refresh()
    })

    expect(cacheReadyOnDevice).toHaveBeenCalledWith('llm', true)
  })

  it('surfaces the binary download phase via binaryState (sentinel id)', async () => {
    const { result } = renderHook(() => useOnDeviceLlmModels())

    await waitFor(() => {
      expect(result.current.catalog).toHaveLength(2)
    })

    // Binary phase starts: backend emits an event with the sentinel id.
    expect(BINARY_PHASE_ID).toBe('_server_binary')
    expect(result.current.binaryState).toEqual({ status: 'not_downloaded' })

    act(() => {
      fireProgress({ id: BINARY_PHASE_ID, phase: 'binary', state: 'downloading', progress: 25 })
    })

    await waitFor(() => {
      expect(result.current.binaryState).toEqual({ status: 'downloading', progress: 25 })
    })

    // The binary phase must NOT bleed into the per-model states map.
    expect(result.current.states[BINARY_PHASE_ID]).toBeUndefined()

    act(() => {
      fireProgress({ id: BINARY_PHASE_ID, phase: 'binary', state: 'ready' })
    })

    await waitFor(() => {
      expect(result.current.binaryState).toEqual({ status: 'ready' })
    })
  })

  describe('Gemma ToU receipt', () => {
    const GEMMA_TERMS_URL = 'https://ai.google.dev/gemma/terms'
    const gatedGemma = (): OnDeviceLlmModelWire =>
      catalogEntry('gemma-4-e4b-it', {
        recommended: true,
        requiresAcceptance: true,
        termsUrl: GEMMA_TERMS_URL,
      })

    it('hydrates termsAccepted from on_device_llm_terms_accepted_at', async () => {
      vi.mocked(tauri.getSetting).mockResolvedValue('2026-08-24T00:00:00.000Z')

      const { result } = renderHook(() => useOnDeviceLlmModels())

      await waitFor(() => {
        expect(result.current.termsAccepted).toBe(true)
      })
      expect(tauri.getSetting).toHaveBeenCalledWith(ON_DEVICE_LLM_TERMS_ACCEPTED_AT)
    })

    it('acceptTerms writes an ISO timestamp then download proceeds', async () => {
      vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([gatedGemma()])
      vi.mocked(tauri.downloadOnDeviceLlmModel).mockResolvedValue(undefined)

      const { result } = renderHook(() => useOnDeviceLlmModels())

      await waitFor(() => {
        expect(result.current.catalog).toHaveLength(1)
        expect(result.current.termsAccepted).toBe(false)
      })

      await act(async () => {
        await result.current.acceptTerms()
      })

      expect(tauri.setSetting).toHaveBeenCalledWith(
        ON_DEVICE_LLM_TERMS_ACCEPTED_AT,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      )
      expect(result.current.termsAccepted).toBe(true)

      await act(async () => {
        await result.current.download('gemma-4-e4b-it')
      })

      expect(tauri.downloadOnDeviceLlmModel).toHaveBeenCalledWith('gemma-4-e4b-it')
    })

    it('download without a terms receipt surfaces a typed gate and does not start the download', async () => {
      vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([gatedGemma()])
      vi.mocked(tauri.downloadOnDeviceLlmModel).mockResolvedValue(undefined)

      const { result } = renderHook(() => useOnDeviceLlmModels())

      await waitFor(() => {
        expect(result.current.catalog[0]?.requires_acceptance).toBe(true)
        expect(result.current.termsAccepted).toBe(false)
      })

      await act(async () => {
        await expect(result.current.download('gemma-4-e4b-it')).rejects.toBeInstanceOf(
          TermsNotAcceptedError,
        )
      })

      expect(tauri.downloadOnDeviceLlmModel).not.toHaveBeenCalled()
      expect(result.current.states['gemma-4-e4b-it']).toEqual({ status: 'not_downloaded' })
    })

    it('maps a backend terms_not_accepted rejection to TermsNotAcceptedError', async () => {
      vi.mocked(tauri.getSetting).mockResolvedValue('2026-08-24T00:00:00.000Z')
      vi.mocked(tauri.listOnDeviceLlmModels).mockResolvedValue([gatedGemma()])
      vi.mocked(tauri.downloadOnDeviceLlmModel).mockRejectedValue('terms_not_accepted')

      const { result } = renderHook(() => useOnDeviceLlmModels())

      await waitFor(() => {
        expect(result.current.termsAccepted).toBe(true)
      })

      await act(async () => {
        await expect(result.current.download('gemma-4-e4b-it')).rejects.toBeInstanceOf(
          TermsNotAcceptedError,
        )
      })

      expect(tauri.downloadOnDeviceLlmModel).toHaveBeenCalledWith('gemma-4-e4b-it')
      expect(result.current.states['gemma-4-e4b-it']).toEqual({
        status: 'error',
        code: TERMS_NOT_ACCEPTED_CODE,
      })
    })
  })
})
