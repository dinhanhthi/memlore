/**
 * Tests for `useBasemap` (Phase 3 T12).
 *
 * Mocking follows the project rule: never call the real Tauri backend.
 * `@tauri-apps/api/event` `listen` and the `../lib/tauri` IPC wrappers
 * are mocked; we drive them via the `handlers` / wrapper spies. The
 * pattern mirrors `useOnDeviceLlmModels.test.ts`.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { BasemapStatusPayload } from '../lib/tauri'
import {
  useBasemap,
  type BasemapDownloadCompleteEvent,
  type BasemapDownloadProgressEvent,
} from './useBasemap'

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
    downloadBasemap: vi.fn(),
    cancelBasemapDownload: vi.fn(),
    basemapStatus: vi.fn(),
    deleteBasemap: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
  }
})

import * as tauri from '../lib/tauri'

const PROGRESS_EVENT = 'basemap:download-progress'
const COMPLETE_EVENT = 'basemap:download-complete'
const PINNED_SIZE = 552_165_687

const fireProgress = (payload: BasemapDownloadProgressEvent) => {
  handlers[PROGRESS_EVENT]?.({ payload })
}

const fireComplete = (payload: BasemapDownloadCompleteEvent) => {
  handlers[COMPLETE_EVENT]?.({ payload })
}

const IDLE: BasemapStatusPayload = {
  status: 'not_downloaded',
  path: null,
  size_bytes: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(handlers)) delete handlers[k]
  for (const k of Object.keys(unlistenSpies)) delete unlistenSpies[k]
  vi.mocked(tauri.basemapStatus).mockResolvedValue(IDLE)
  vi.mocked(tauri.downloadBasemap).mockResolvedValue(undefined)
  vi.mocked(tauri.cancelBasemapDownload).mockResolvedValue(undefined)
  vi.mocked(tauri.deleteBasemap).mockResolvedValue(undefined)
  vi.mocked(tauri.getSetting).mockResolvedValue(null)
  vi.mocked(tauri.setSetting).mockResolvedValue(undefined)
})

describe('useBasemap', () => {
  it('hydrates status from the backend on mount', async () => {
    vi.mocked(tauri.basemapStatus).mockResolvedValue({
      status: 'ready',
      path: '/tmp/basemap/world.pmtiles',
      size_bytes: PINNED_SIZE,
    })

    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })

    expect(tauri.basemapStatus).toHaveBeenCalledTimes(1)
    expect(result.current.path).toBe('/tmp/basemap/world.pmtiles')
    expect(result.current.size_bytes).toBe(PINNED_SIZE)
  })

  it('progress events update percent from downloaded/total', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    act(() => {
      fireProgress({ downloaded: 276_082_843, total: PINNED_SIZE })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('downloading')
      expect(result.current.downloaded).toBe(276_082_843)
      expect(result.current.total).toBe(PINNED_SIZE)
      expect(result.current.percent).toBeCloseTo((276_082_843 / PINNED_SIZE) * 100)
    })
  })

  it('does not divide by zero when progress total is 0', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    act(() => {
      fireProgress({ downloaded: 12_345, total: 0 })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('downloading')
      expect(Number.isFinite(result.current.percent)).toBe(true)
      expect(result.current.percent).toBeCloseTo((12_345 / PINNED_SIZE) * 100)
    })
  })

  it('progress events broadcast percent to sibling hooks', async () => {
    const a = renderHook(() => useBasemap())
    const b = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(handlers[PROGRESS_EVENT]).toBeDefined()
    })

    act(() => {
      fireProgress({ downloaded: 276_082_843, total: PINNED_SIZE })
    })

    await waitFor(() => {
      expect(a.result.current.percent).toBeCloseTo((276_082_843 / PINNED_SIZE) * 100)
    })
    await waitFor(() => {
      expect(b.result.current.percent).toBeCloseTo((276_082_843 / PINNED_SIZE) * 100)
    })
  })

  it('download() does not wipe in-flight progress when status is still downloading', async () => {
    const { result } = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    let finishStatus!: (payload: BasemapStatusPayload) => void
    vi.mocked(tauri.basemapStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve
        }),
    )

    let downloadDone: Promise<void> = Promise.resolve()
    await act(async () => {
      downloadDone = result.current.download()
    })

    act(() => {
      fireProgress({ downloaded: 276_082_843, total: PINNED_SIZE })
    })
    await waitFor(() => {
      expect(result.current.percent).toBeGreaterThan(40)
    })

    await act(async () => {
      finishStatus({ status: 'downloading', path: null, size_bytes: null })
      await downloadDone
    })

    expect(result.current.status).toBe('downloading')
    expect(result.current.percent).toBeGreaterThan(40)
  })

  it('cancel() calls the cancelBasemapDownload wrapper', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    await act(async () => {
      await result.current.cancel()
    })

    expect(tauri.cancelBasemapDownload).toHaveBeenCalledTimes(1)
  })

  it('download_cancelled complete event resets to not_downloaded', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(handlers[COMPLETE_EVENT]).toBeDefined()
    })

    act(() => {
      fireProgress({ downloaded: 276_082_843, total: PINNED_SIZE })
    })
    await waitFor(() => {
      expect(result.current.status).toBe('downloading')
    })

    vi.mocked(tauri.basemapStatus).mockResolvedValue(IDLE)
    act(() => {
      fireComplete({
        status: 'error',
        path: null,
        size_bytes: null,
        code: 'download_cancelled',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })
    expect(result.current.percent).toBe(0)
  })

  it('download() calls the downloadBasemap wrapper', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    await act(async () => {
      await result.current.download()
    })

    expect(tauri.downloadBasemap).toHaveBeenCalledTimes(1)
  })

  it('last-byte progress stays downloading, not ready', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    act(() => {
      fireProgress({ downloaded: PINNED_SIZE, total: PINNED_SIZE })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('downloading')
      expect(result.current.percent).toBe(100)
    })
  })

  it('terminal ready event sets ready after verify', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(handlers[COMPLETE_EVENT]).toBeDefined()
    })

    act(() => {
      fireProgress({ downloaded: PINNED_SIZE, total: PINNED_SIZE })
    })
    await waitFor(() => {
      expect(result.current.status).toBe('downloading')
    })

    act(() => {
      fireComplete({
        status: 'ready',
        path: '/tmp/basemap/world.pmtiles',
        size_bytes: PINNED_SIZE,
        code: null,
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })
    expect(result.current.path).toBe('/tmp/basemap/world.pmtiles')
    expect(result.current.size_bytes).toBe(PINNED_SIZE)
  })

  it('terminal error rehydrates so the UI is not stuck downloading', async () => {
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(handlers[COMPLETE_EVENT]).toBeDefined()
      expect(result.current.status).toBe('not_downloaded')
    })

    act(() => {
      fireProgress({ downloaded: PINNED_SIZE, total: PINNED_SIZE })
    })
    await waitFor(() => {
      expect(result.current.status).toBe('downloading')
    })

    vi.mocked(tauri.basemapStatus).mockResolvedValue(IDLE)
    act(() => {
      fireComplete({
        status: 'error',
        path: null,
        size_bytes: null,
        code: 'download_sha256_mismatch',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })
  })

  it('download() rehydrates when the command fails so status is not stuck', async () => {
    vi.mocked(tauri.downloadBasemap).mockRejectedValue(new Error('already_downloading'))
    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('not_downloaded')
    })

    await act(async () => {
      await result.current.download()
    })

    expect(result.current.status).toBe('not_downloaded')
    expect(tauri.basemapStatus).toHaveBeenCalled()
  })

  it('delete() calls the deleteBasemap wrapper', async () => {
    vi.mocked(tauri.basemapStatus).mockResolvedValue({
      status: 'ready',
      path: '/tmp/basemap/world.pmtiles',
      size_bytes: PINNED_SIZE,
    })

    const { result } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })

    await act(async () => {
      await result.current.delete()
    })

    expect(tauri.deleteBasemap).toHaveBeenCalledTimes(1)
  })

  it('terminal ready broadcasts to sibling hooks', async () => {
    const a = renderHook(() => useBasemap())
    const b = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(handlers[COMPLETE_EVENT]).toBeDefined()
    })

    act(() => {
      fireComplete({
        status: 'ready',
        path: '/tmp/basemap/world.pmtiles',
        size_bytes: PINNED_SIZE,
        code: null,
      })
    })

    await waitFor(() => {
      expect(a.result.current.status).toBe('ready')
    })
    await waitFor(() => {
      expect(b.result.current.status).toBe('ready')
    })
    expect(a.result.current.path).toBe('/tmp/basemap/world.pmtiles')
  })

  it('delete() of a ready archive clears map_tile_source when it was offline', async () => {
    vi.mocked(tauri.basemapStatus).mockResolvedValue({
      status: 'ready',
      path: '/tmp/basemap/world.pmtiles',
      size_bytes: PINNED_SIZE,
    })
    let deleted = false
    vi.mocked(tauri.deleteBasemap).mockImplementation(async () => {
      deleted = true
    })
    vi.mocked(tauri.getSetting).mockImplementation(async (key) => {
      if (key === 'map_tile_source') {
        expect(deleted).toBe(false)
        return 'offline'
      }
      return null
    })

    const { result } = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })

    await act(async () => {
      await result.current.delete()
    })

    expect(tauri.getSetting).toHaveBeenCalledWith('map_tile_source')
    expect(tauri.deleteBasemap).toHaveBeenCalledTimes(1)
    expect(tauri.setSetting).toHaveBeenCalledWith('map_tile_source', '')
    expect(result.current.status).toBe('not_downloaded')
  })

  it('delete() does not clear map_tile_source when the source is maptiler', async () => {
    vi.mocked(tauri.basemapStatus).mockResolvedValue({
      status: 'ready',
      path: '/tmp/basemap/world.pmtiles',
      size_bytes: PINNED_SIZE,
    })
    vi.mocked(tauri.getSetting).mockResolvedValue('maptiler')

    const { result } = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(result.current.status).toBe('ready')
    })

    await act(async () => {
      await result.current.delete()
    })

    expect(tauri.getSetting).toHaveBeenCalledWith('map_tile_source')
    expect(tauri.deleteBasemap).toHaveBeenCalledTimes(1)
    expect(tauri.setSetting).not.toHaveBeenCalled()
  })

  it('delete() broadcasts not_downloaded to other hook instances', async () => {
    vi.mocked(tauri.basemapStatus).mockResolvedValue({
      status: 'ready',
      path: '/tmp/basemap/world.pmtiles',
      size_bytes: PINNED_SIZE,
    })

    const a = renderHook(() => useBasemap())
    const b = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(a.result.current.status).toBe('ready')
    })
    await waitFor(() => {
      expect(b.result.current.status).toBe('ready')
    })

    await act(async () => {
      await a.result.current.delete()
    })

    expect(a.result.current.status).toBe('not_downloaded')
    expect(b.result.current.status).toBe('not_downloaded')
    expect(b.result.current.path).toBeNull()
  })

  it('remount while downloading still shows downloading (self-heal)', async () => {
    vi.mocked(tauri.basemapStatus).mockResolvedValue({
      status: 'downloading',
      path: null,
      size_bytes: null,
    })

    const first = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(first.result.current.status).toBe('downloading')
    })
    first.unmount()

    const second = renderHook(() => useBasemap())
    await waitFor(() => {
      expect(second.result.current.status).toBe('downloading')
    })
    expect(tauri.basemapStatus).toHaveBeenCalledTimes(2)
  })

  it('unmount unsubscribes the progress listener', async () => {
    const { unmount } = renderHook(() => useBasemap())

    await waitFor(() => {
      expect(handlers[PROGRESS_EVENT]).toBeDefined()
      expect(handlers[COMPLETE_EVENT]).toBeDefined()
    })

    const progressUnlisten = unlistenSpies[PROGRESS_EVENT]
    const completeUnlisten = unlistenSpies[COMPLETE_EVENT]
    unmount()
    expect(progressUnlisten).toHaveBeenCalledTimes(1)
    expect(completeUnlisten).toHaveBeenCalledTimes(1)
  })

  it('does not leak the progress listener when unmounted before listen() resolves', async () => {
    let resolveProgressListen!: (fn: UnlistenFn) => void
    const progressUnlisten: UnlistenFn = vi.fn()

    vi.mocked(listen).mockImplementationOnce(
      (() =>
        new Promise<UnlistenFn>((resolve) => {
          resolveProgressListen = resolve
        })) as typeof listen,
    )

    const { unmount } = renderHook(() => useBasemap())
    unmount()

    await act(async () => {
      resolveProgressListen(progressUnlisten)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(progressUnlisten).toHaveBeenCalledTimes(1)
  })
})
