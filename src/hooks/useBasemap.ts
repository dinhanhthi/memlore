/**
 * Offline world PMTiles basemap status + download/delete triggers
 * (Phase 3 T12).
 *
 * Hydrates from `basemap_status` on every mount and listens to
 * `basemap:download-progress` for live percent. Terminal ready/error
 * arrives on `basemap:download-complete` (or a follow-up status
 * rehydrate) — last-byte progress stays `downloading` at 100%.
 * Self-heals after remount: if the backend still reports `downloading`,
 * the UI keeps showing progress. Never gate the listener or the chip on
 * a local `running` flag (memory: `project_ui_flag_cleared_only_by_event`).
 *
 * Components never call `invoke()` — all IPC lives in `../lib/tauri`.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useState } from 'react'
import { resetBasemapPmtilesCache } from '../lib/pmtilesSource'
import {
  BASEMAP_SIZE_BYTES,
  basemapStatus,
  cancelBasemapDownload,
  deleteBasemap,
  downloadBasemap,
  getSetting,
  type BasemapStatusKind,
  type BasemapStatusPayload,
} from '../lib/tauri'
import { clearMapTileSource } from './useMapSourceSettings'

export type { BasemapStatusKind, BasemapStatusPayload }

/** `basemap:download-progress` event payload. Byte ticks only. */
export interface BasemapDownloadProgressEvent {
  downloaded: number
  total: number
}

/** `basemap:download-complete` — emitted after SHA/rename (or on failure). */
export interface BasemapDownloadCompleteEvent {
  status: 'ready' | 'error'
  path: string | null
  size_bytes: number | null
  code: string | null
}

export interface UseBasemap {
  status: BasemapStatusKind
  path: string | null
  size_bytes: number | null
  downloaded: number
  total: number
  percent: number
  /** True after the first `basemap_status` attempt (success or fail). */
  hydrated: boolean
  download: () => Promise<void>
  /** Best-effort cancel of an in-flight download. Status clears on the complete event. */
  cancel: () => Promise<void>
  delete: () => Promise<void>
}

interface BasemapSnapshot {
  status: BasemapStatusKind
  path: string | null
  size_bytes: number | null
  downloaded: number
  total: number
}

const listeners = new Set<(snap: BasemapSnapshot) => void>()

function publishBasemap(snap: BasemapSnapshot) {
  for (const listener of listeners) listener(snap)
}

function percentOf(downloaded: number, total: number): number {
  const denom = total > 0 ? total : BASEMAP_SIZE_BYTES
  if (denom <= 0) return 0
  return (downloaded / denom) * 100
}

const IDLE_SNAP: BasemapSnapshot = {
  status: 'not_downloaded',
  path: null,
  size_bytes: null,
  downloaded: 0,
  total: 0,
}

export function useBasemap(): UseBasemap {
  const [status, setStatus] = useState<BasemapStatusKind>('not_downloaded')
  const [path, setPath] = useState<string | null>(null)
  const [size_bytes, setSizeBytes] = useState<number | null>(null)
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [hydrated, setHydrated] = useState(false)

  function applyStatus(payload: BasemapStatusPayload) {
    setStatus(payload.status)
    setPath(payload.path)
    setSizeBytes(payload.size_bytes)
  }

  useEffect(() => {
    let cancelled = false
    async function hydrate() {
      try {
        const payload = await basemapStatus()
        if (cancelled) return
        applyStatus(payload)
      } catch (e) {
        console.warn('useBasemap: hydrate failed', e)
      } finally {
        if (!cancelled) setHydrated(true)
      }
    }
    void hydrate()

    const onPublish = (snap: BasemapSnapshot) => {
      setStatus(snap.status)
      setPath(snap.path)
      setSizeBytes(snap.size_bytes)
      setDownloaded(snap.downloaded)
      setTotal(snap.total)
    }
    listeners.add(onPublish)

    return () => {
      cancelled = true
      listeners.delete(onPublish)
    }
  }, [])

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      try {
        const unProgress = await listen<BasemapDownloadProgressEvent>(
          'basemap:download-progress',
          (event) => {
            const { downloaded: nextDownloaded, total: nextTotal } = event.payload
            const snap: BasemapSnapshot = {
              status: 'downloading',
              path: null,
              size_bytes: null,
              downloaded: nextDownloaded,
              total: nextTotal,
            }
            setDownloaded(snap.downloaded)
            setTotal(snap.total)
            // Last-byte tick is still in-flight: SHA/rename have not run.
            setStatus(snap.status)
            publishBasemap(snap)
          },
        )
        if (cancelled) {
          unProgress()
          return
        }
        unlisteners.push(unProgress)

        const unComplete = await listen<BasemapDownloadCompleteEvent>(
          'basemap:download-complete',
          (event) => {
            const payload = event.payload
            if (payload.status === 'ready') {
              const snap: BasemapSnapshot = {
                status: 'ready',
                path: payload.path,
                size_bytes: payload.size_bytes,
                downloaded: payload.size_bytes ?? BASEMAP_SIZE_BYTES,
                total: payload.size_bytes ?? BASEMAP_SIZE_BYTES,
              }
              setStatus(snap.status)
              setPath(snap.path)
              setSizeBytes(snap.size_bytes)
              setDownloaded(snap.downloaded)
              setTotal(snap.total)
              publishBasemap(snap)
              return
            }
            void (async () => {
              try {
                const next = await basemapStatus()
                applyStatus(next)
                publishBasemap({
                  status: next.status,
                  path: next.path,
                  size_bytes: next.size_bytes,
                  downloaded: 0,
                  total: 0,
                })
              } catch (e) {
                console.warn('useBasemap: error rehydrate failed', e)
                applyStatus({
                  status: 'not_downloaded',
                  path: null,
                  size_bytes: null,
                })
                publishBasemap(IDLE_SNAP)
              }
            })()
          },
        )
        if (cancelled) {
          unComplete()
          return
        }
        unlisteners.push(unComplete)
      } catch (e) {
        console.warn('useBasemap: subscribe failed', e)
      }
    }

    void subscribe()
    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [])

  const download = useCallback(async () => {
    setStatus('downloading')
    publishBasemap({
      status: 'downloading',
      path: null,
      size_bytes: null,
      downloaded: 0,
      total: BASEMAP_SIZE_BYTES,
    })
    try {
      await downloadBasemap()
    } catch (e) {
      console.warn('useBasemap: download command failed', e)
    }
    try {
      const payload = await basemapStatus()
      applyStatus(payload)
      // The command returns as soon as the fetch is spawned. A follow-up
      // status poll that still says `downloading` must not reset percent —
      // progress events already own those counters.
      if (payload.status === 'ready') {
        publishBasemap({
          status: 'ready',
          path: payload.path,
          size_bytes: payload.size_bytes,
          downloaded: payload.size_bytes ?? BASEMAP_SIZE_BYTES,
          total: payload.size_bytes ?? BASEMAP_SIZE_BYTES,
        })
      } else if (payload.status !== 'downloading') {
        publishBasemap({
          status: payload.status,
          path: payload.path,
          size_bytes: payload.size_bytes,
          downloaded: 0,
          total: 0,
        })
      }
    } catch (e) {
      console.warn('useBasemap: post-download rehydrate failed', e)
      applyStatus({ status: 'not_downloaded', path: null, size_bytes: null })
      publishBasemap(IDLE_SNAP)
    }
  }, [])

  const cancel = useCallback(async () => {
    try {
      await cancelBasemapDownload()
    } catch (e) {
      console.warn('useBasemap: cancel command failed', e)
    }
  }, [])

  const remove = useCallback(async () => {
    // Capture before `deleteBasemap`: the backend already drops
    // `map_tile_source` when it was `offline`, so a post-delete getSetting
    // would miss the live-listener teardown.
    const sourceBefore = await getSetting('map_tile_source')
    await deleteBasemap()
    resetBasemapPmtilesCache()
    setStatus('not_downloaded')
    setPath(null)
    setSizeBytes(null)
    setDownloaded(0)
    setTotal(0)
    publishBasemap(IDLE_SNAP)
    if (sourceBefore === 'offline') {
      await clearMapTileSource()
    }
  }, [])

  return {
    status,
    path,
    size_bytes,
    downloaded,
    total,
    percent: percentOf(downloaded, total),
    hydrated,
    download,
    cancel,
    delete: remove,
  }
}
