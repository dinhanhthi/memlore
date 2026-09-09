/**
 * On-device embedding model catalog + download-state hook (Phase 4 Task 5).
 *
 * The catalog's static decision metadata (display name, dims, RAM, when-to-
 * choose copy) stays a frontend constant — it's already fully i18n'd and
 * tested, and the backend `OnDeviceModelWire` carries the same fields under
 * different casing, so duplicating the source of truth buys nothing. What
 * this hook now gets from the backend is the part that can't live in a
 * frontend constant: each model's live download state (`list_on_device_models`
 * on mount) and download/cancel/remove actions, plus real-time progress via
 * the `ai:model-download-progress` / `ai:model-download-error` events the
 * command layer emits (see `src-tauri/src/commands/ai_provider.rs`).
 *
 * Every catalog model today maps to a real `fastembed` 4.9.1 backend, so
 * `supported` is always `true` in practice — but the mechanism stays: if a
 * future catalog entry ever ships with `supported: false`, this hook still
 * surfaces that as a permanent `error` state with `errorKey: 'not_supported'`
 * and never calls the download command for that id, so the UI would show a
 * clear "not supported yet" message instead of a fake progress bar or a
 * doomed-to-fail network call.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cacheReadyOnDevice } from '../lib/aiFeatureAccessors'
import {
  cancelOnDeviceModelDownload,
  listOnDeviceModels,
  removeOnDeviceModel,
  startOnDeviceModelDownload,
  type OnDeviceModelStateWire,
} from '../lib/tauri'
import type { ModelDownloadErrorEvent, ModelDownloadProgressEvent } from '../types/ai'

export interface OnDeviceModelCatalogEntry {
  /** Provisional id — Phase 4's `catalog.rs` is the source of truth once it lands. */
  id: string
  /** Model name (proper noun, not translated). */
  displayName: string
  /** English default for the localized "when to choose" one-liner. */
  whenToChoose: string
  /** English default for the localized download-size copy, e.g. "~1.2 GB". */
  downloadSize: string
  /** Approximate on-disk size in bytes — mirrors `catalog.rs` `download_size_bytes`. */
  downloadSizeBytes: number
  /** English default for the localized approx-RAM copy, e.g. "~2-3 GB". */
  approxRam: string
  /** Upper bound of the approx-RAM range in GB — drives the high-RAM warning. */
  ramGbUpperBound: number
  /** Embedding vector dimensions. */
  dim: number
  /** Max context length in tokens. */
  contextLength: number
  multilingual: boolean
  /** Recommended default (`multilingual-e5-base`). */
  recommended: boolean
}

/** Catalog data — mirrors `src-tauri/src/ai/on_device/catalog.rs` exactly. */
export const ON_DEVICE_MODEL_CATALOG: OnDeviceModelCatalogEntry[] = [
  {
    id: 'multilingual-e5-base',
    displayName: 'multilingual-e5-base',
    whenToChoose: 'Best balance for multilingual/Vietnamese journals.',
    downloadSize: '~1.1 GB',
    downloadSizeBytes: 1_150_000_000,
    approxRam: '~1.5-2 GB',
    ramGbUpperBound: 2,
    dim: 768,
    contextLength: 512,
    multilingual: true,
    recommended: true,
  },
  {
    id: 'multilingual-e5-small',
    displayName: 'multilingual-e5-small',
    whenToChoose: 'Lightest multilingual option; best for low-RAM machines.',
    downloadSize: '~470 MB',
    downloadSizeBytes: 470_000_000,
    approxRam: '~0.6-1 GB',
    ramGbUpperBound: 1,
    dim: 384,
    contextLength: 512,
    multilingual: true,
    recommended: false,
  },
  {
    id: 'multilingual-e5-large',
    displayName: 'multilingual-e5-large',
    whenToChoose: 'Highest multilingual quality; needs a capable machine.',
    downloadSize: '~2.2 GB',
    downloadSizeBytes: 2_200_000_000,
    approxRam: '~3-4 GB',
    ramGbUpperBound: 4,
    dim: 1024,
    contextLength: 512,
    multilingual: true,
    recommended: false,
  },
  {
    id: 'nomic-embed-text-v1.5',
    displayName: 'nomic-embed-text-v1.5',
    whenToChoose: 'Long entries (8K context); strongest for English.',
    downloadSize: '~275 MB',
    downloadSizeBytes: 275_000_000,
    approxRam: '~0.5-1 GB',
    ramGbUpperBound: 1,
    dim: 768,
    contextLength: 8192,
    multilingual: false,
    recommended: false,
  },
]

/** Copy-only warning threshold — no hardware probing, just a heuristic over
 *  the catalog's approx-RAM upper bound relative to typical machines. */
const HIGH_RAM_GB_THRESHOLD = 2

export function isHighRamModel(entry: OnDeviceModelCatalogEntry): boolean {
  return entry.ramGbUpperBound > HIGH_RAM_GB_THRESHOLD
}

export function getRecommendedModel(
  catalog: OnDeviceModelCatalogEntry[] = ON_DEVICE_MODEL_CATALOG,
): OnDeviceModelCatalogEntry | undefined {
  return catalog.find((entry) => entry.recommended)
}

/** Filters the catalog down to models actually downloaded and usable on
 *  this device (`status === 'ready'`). Used by the feature tabs' model
 *  dropdown (T4.2) so an on-device provider only ever offers models that
 *  are really on disk — never a preset suggestion string the user hasn't
 *  downloaded. */
export function getReadyModels(
  catalog: OnDeviceModelCatalogEntry[],
  states: Record<string, ModelDownloadState>,
): OnDeviceModelCatalogEntry[] {
  return catalog.filter((entry) => states[entry.id]?.status === 'ready')
}

export type ModelDownloadStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'

export interface ModelDownloadState {
  status: ModelDownloadStatus
  /** 0-100, only meaningful while `status === 'downloading'`. */
  progress?: number
  /** Estimated seconds remaining — only meaningful while `status === 'downloading'`.
   *  Not populated today; the backend only reports a percent, no ETA. */
  etaSeconds?: number
  /** Either a short code with a localized `on_device_models.error_*` string
   *  (e.g. `not_available_yet`, `not_supported`), or a raw backend error
   *  message (fastembed/hf_hub chain) shown verbatim via the
   *  `status_error_detail` fallback — see `OnDeviceModelPicker`'s
   *  `ModelStatus`. */
  errorKey?: string
}

export interface UseOnDeviceModelsReturn {
  catalog: OnDeviceModelCatalogEntry[]
  /** Currently active on-device model, or `null` if none — passed through
   *  from the caller (see the `currentModelId` param), which reads it off
   *  the persisted embedding-slot config. */
  currentModelId: string | null
  states: Record<string, ModelDownloadState>
  download: (id: string) => void
  retry: (id: string) => void
  cancel: (id: string) => void
  remove: (id: string) => Promise<void>
  /** Re-hydrate download state from the backend. Needed because `ready`
   *  is only written by the instance that started the download; removal
   *  is broadcast as `ai:model-removed` and dropped locally. */
  refresh: () => Promise<void>
}

function initialStates(): Record<string, ModelDownloadState> {
  return Object.fromEntries(
    ON_DEVICE_MODEL_CATALOG.map((entry) => [entry.id, { status: 'not_downloaded' as const }]),
  )
}

/** Map a backend wire state to the hook's local shape. `supported === false`
 *  always wins — an unsupported model is permanently `error` regardless of
 *  what the backend's (never-reached, in practice) state says. */
function fromWireState(wire: OnDeviceModelStateWire, supported: boolean): ModelDownloadState {
  if (!supported) return { status: 'error', errorKey: 'not_supported' }
  if (wire.status === 'downloading') return { status: 'downloading', progress: wire.progress }
  if (wire.status === 'error') return { status: 'error', errorKey: wire.code }
  return { status: wire.status }
}

/** @param currentModelId The model id currently active for the embedding
 *  slot (i.e. `providers.embedding.embeddingModel` when
 *  `providers.embedding.provider === 'on-device'`), or `null` when the
 *  embedding slot isn't on-device / isn't configured yet. Callers read this
 *  from `useAIProviderConfig` and pass it straight through — this hook has
 *  no way to know the active slot on its own. */
export function useOnDeviceModels(currentModelId: string | null = null): UseOnDeviceModelsReturn {
  const [states, setStates] = useState<Record<string, ModelDownloadState>>(initialStates)
  // Ref (not state) — read synchronously from action callbacks without
  // needing them in a dependency array; never drives a render itself.
  const supportedRef = useRef<Record<string, boolean>>({})

  /** Re-hydrate download state from the backend.
   *
   *  Download events only carry `downloading` and `error`:
   *   - `ready` is written only by `download()`'s resolved promise, on the
   *     instance that started the download (the progress listener calls
   *     this on the 100% tick to close that gap).
   *   - removal is broadcast as `ai:model-removed`; every instance drops
   *     that id from catalog state and updates the palette cache.
   *
   *  Without both, the Providers tab — which lifts this hook to decide
   *  whether an on-device card counts as connected — would miss a model
   *  that just finished downloading. */
  const refresh = useCallback(async () => {
    try {
      const models = await listOnDeviceModels()
      const nextStates: Record<string, ModelDownloadState> = {}
      for (const model of models) {
        supportedRef.current[model.id] = model.supported
        nextStates[model.id] = fromWireState(model.state, model.supported)
      }
      setStates((prev) => ({ ...prev, ...nextStates }))
      // Palette gate — any mounted instance feeds it, not only Settings.
      cacheReadyOnDevice('embed', getReadyModels(ON_DEVICE_MODEL_CATALOG, nextStates).length > 0)
    } catch (e) {
      console.warn('useOnDeviceModels: failed to load catalog state', e)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      try {
        const unProgress = await listen<ModelDownloadProgressEvent>(
          'ai:model-download-progress',
          (event) => {
            const { model_id, progress } = event.payload
            // A 100% tick can race the resolved `start_on_device_model_download`
            // promise landing `ready` first — never let a progress tick
            // clobber a terminal state.
            setStates((prev) => {
              const current = prev[model_id]?.status
              if (current === 'ready' || current === 'error') return prev
              return { ...prev, [model_id]: { status: 'downloading', progress } }
            })
            // The terminal `ready` is only ever written by `download()`'s own
            // resolved promise — i.e. only on the instance that STARTED the
            // download. Progress events reach every instance, but they top
            // out at `downloading` 100%. Without this re-read, an instance
            // that merely observed (the Providers tab, after the user closed
            // the picker modal mid-download) would sit at 100% forever and
            // never list the finished model as downloaded.
            if (progress >= 100) void refresh()
          },
        )
        unlisteners.push(unProgress)
        if (cancelled) return

        const unError = await listen<ModelDownloadErrorEvent>(
          'ai:model-download-error',
          (event) => {
            const { model_id, error } = event.payload
            setStates((prev) => ({ ...prev, [model_id]: { status: 'error', errorKey: error } }))
          },
        )
        unlisteners.push(unError)
        if (cancelled) return

        const unRemoved = await listen<{ id: string; kind: 'embed' | 'llm' }>(
          'ai:model-removed',
          (event) => {
            const { id, kind } = event.payload
            if (kind !== 'embed') return
            setStates((prev) => {
              const next = { ...prev, [id]: { status: 'not_downloaded' as const } }
              cacheReadyOnDevice('embed', getReadyModels(ON_DEVICE_MODEL_CATALOG, next).length > 0)
              return next
            })
          },
        )
        if (cancelled) {
          unRemoved()
          return
        }
        unlisteners.push(unRemoved)
      } catch (e) {
        console.warn('useOnDeviceModels: subscribe failed', e)
      }
    }

    void subscribe()
    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [refresh])

  function download(id: string) {
    if (supportedRef.current[id] === false) {
      setStates((prev) => ({ ...prev, [id]: { status: 'error', errorKey: 'not_supported' } }))
      return
    }
    setStates((prev) => ({ ...prev, [id]: { status: 'downloading', progress: 0 } }))
    startOnDeviceModelDownload(id)
      .then((wire) => {
        setStates((prev) => ({
          ...prev,
          [id]: fromWireState(wire, supportedRef.current[id] ?? true),
        }))
      })
      .catch((e) => {
        setStates((prev) => ({ ...prev, [id]: { status: 'error', errorKey: String(e) } }))
      })
  }

  function cancel(id: string) {
    cancelOnDeviceModelDownload(id)
      .then((wire) => {
        setStates((prev) => ({
          ...prev,
          [id]: fromWireState(wire, supportedRef.current[id] ?? true),
        }))
      })
      .catch((e) => console.warn('useOnDeviceModels: cancel failed', e))
  }

  async function remove(id: string) {
    const wire = await removeOnDeviceModel(id)
    setStates((prev) => {
      const next = {
        ...prev,
        [id]: fromWireState(wire, supportedRef.current[id] ?? true),
      }
      cacheReadyOnDevice('embed', getReadyModels(ON_DEVICE_MODEL_CATALOG, next).length > 0)
      return next
    })
  }

  return {
    catalog: ON_DEVICE_MODEL_CATALOG,
    currentModelId,
    states,
    download,
    retry: download,
    cancel,
    remove,
    refresh,
  }
}
