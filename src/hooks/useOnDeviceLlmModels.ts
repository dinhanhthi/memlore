/**
 * On-device LLM chat catalog + download-state + server-status hook
 * (Phase 5 Task 1).
 *
 * Mirrors `useOnDeviceModels.ts` conventions but with one deliberate
 * difference: the catalog is hydrated purely from the backend
 * `list_on_device_llm_models` command — there is NO static frontend
 * copy (unlike `ON_DEVICE_MODEL_CATALOG`). The backend already joins
 * catalog metadata + live download state, so a static copy would only
 * drift out of sync. This is cleaner than the embedding approach.
 *
 * State surfaces:
 *  - `catalog` / `states` — model picker (one row per catalog model).
 *  - `binaryState` — the llama-server binary download phase. The backend
 *    emits `on-device-llm:download-progress` events with a sentinel id
 *    (BINARY_PHASE_ID) and `phase: 'binary'` for the sidecar binary
 *    fetch; we route those into `binaryState` instead of `states` so the
 *    binary progress never appears as a fake catalog row.
 *  - `serverStatus` — llama-server lifecycle for the warm-up modal +
 *    footer chip.
 *
 * Terminal-state discipline (matches `useOnDeviceModels`):
 *  - Once a model reaches `ready` or `error`, a late `downloading`
 *    event MUST NOT clobber it.
 *  - Once the server reaches `ready` or `failed`, a late `starting`
 *    event MUST NOT clobber it.
 *
 * Components never call `invoke()` directly — all IPC lives in the
 * `../lib/tauri` wrappers (project rule).
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cacheReadyOnDevice } from '../lib/aiFeatureAccessors'
import {
  cancelOnDeviceLlmDownload,
  deleteOnDeviceLlmBinary,
  deleteOnDeviceLlmModel,
  downloadOnDeviceLlmModel,
  getOnDeviceLlmServerStatus,
  getSetting,
  listOnDeviceLlmModels,
  onDeviceLlmBinaryStatus,
  setSetting,
  type OnDeviceLlmDownloadStateWire,
  type OnDeviceLlmModelWire,
  type OnDeviceLlmServerStateWire,
} from '../lib/tauri'

/** Sentinel id the backend uses for the llama-server binary download
 *  phase (as opposed to a real model id). Events carrying this id are
 *  routed into `binaryState`, not the per-model `states` map. */
export const BINARY_PHASE_ID = '_server_binary'

/** Device-local Gemma ToU receipt (ISO timestamp). Mirrors the backend
 *  `ON_DEVICE_LLM_TERMS_ACCEPTED_AT` setting — not in `SYNCABLE_SETTING_KEYS`. */
export const ON_DEVICE_LLM_TERMS_ACCEPTED_AT = 'on_device_llm_terms_accepted_at'

/** Backend error code when a ToU-gated model is downloaded without a receipt. */
export const TERMS_NOT_ACCEPTED_CODE = 'terms_not_accepted'

/** Thrown when a Gemma (or other ToU-gated) download is blocked pending
 *  `acceptTerms()`. The picker maps this to the ToU modal. */
export class TermsNotAcceptedError extends Error {
  readonly code = TERMS_NOT_ACCEPTED_CODE
  constructor() {
    super(TERMS_NOT_ACCEPTED_CODE)
    this.name = 'TermsNotAcceptedError'
  }
}

/** Backend error code emitted when a download is cancelled by the user. A
 *  cancel is intentional — NOT a failure — so the UI maps it back to
 *  `not_downloaded` (Download button, no error line) instead of `error`. */
const CANCELLED_CODE = 'download_cancelled'

export interface OnDeviceLlmCatalogEntry {
  id: string
  display_name: string
  download_size_bytes: number
  context_tokens: number
  min_ram_gb: number
  recommended: boolean
  multilingual: boolean
  when_to_choose: string
  terms_url: string
  requires_acceptance: boolean
}

export type LlmDownloadStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'

export interface LlmModelState {
  status: LlmDownloadStatus
  /** 0-100, only meaningful while `status === 'downloading'`. */
  progress?: number
  /** Error code when `status === 'error'`. */
  code?: string
}

export type LlmServerState = 'stopped' | 'starting' | 'ready' | 'failed'

export interface LlmServerStatus {
  state: LlmServerState
  model_id?: string
  port?: number
  /** Error code when `state === 'failed'`. */
  code?: string
}

/** `on-device-llm:download-progress` event payload. `phase` distinguishes
 *  the sidecar binary fetch (`'binary'`) from a model GGUF fetch
 *  (`'model'`); when `phase === 'binary'`, `id` is `BINARY_PHASE_ID`. */
export interface OnDeviceLlmDownloadProgressEvent {
  id: string
  phase?: 'binary' | 'model'
  state: 'downloading' | 'ready' | 'error'
  progress?: number
  code?: string
}

/** `on-device-llm:server-status` event payload. */
export interface OnDeviceLlmServerStatusEvent {
  state: LlmServerState
  model_id?: string
  port?: number
  code?: string
}

export interface UseOnDeviceLlmModelsReturn {
  catalog: OnDeviceLlmCatalogEntry[]
  states: Record<string, LlmModelState>
  /** llama-server binary download phase — shown as a distinct progress
   *  row in the picker, separate from any model. */
  binaryState: LlmModelState
  serverStatus: LlmServerStatus
  /** Kick off a model download (fire-and-forget; progress via events).
   *  Rejects with `TermsNotAcceptedError` when a gated model has no receipt. */
  download: (id: string) => Promise<void>
  /** Best-effort cancel of an in-flight download. */
  cancelDownload: (id: string) => Promise<void>
  /** Delete a downloaded model. If it was the active generation model the
   *  backend forgets the slot and stops the sidecar first — this never
   *  rejects with `"model_in_use"`. */
  remove: (id: string) => Promise<void>
  /** Delete the llama-server sidecar binary. If generation is on-device-llm
   *  the backend forgets the slot and stops the sidecar first. */
  removeBinary: () => Promise<void>
  /** Re-hydrate catalog/states/serverStatus/binaryState from the backend. */
  refresh: () => Promise<void>
  /** True when this device has a non-empty ToU receipt. */
  termsAccepted: boolean
  /** Stamp `on_device_llm_terms_accepted_at` with now (ISO) and flip state. */
  acceptTerms: () => Promise<void>
}

const NOT_DOWNLOADED: LlmModelState = { status: 'not_downloaded' }
const SERVER_STOPPED: LlmServerStatus = { state: 'stopped' }

/** A download/server state is "terminal-ish" — once reached, a stale
 *  in-flight event must not regress it. For models: `ready`/`error`.
 *  For the server: `ready`/`failed` (the server can legitimately cycle
 *  back to `stopped`, but a late `starting` racing a just-landed
 *  `ready`/`failed` should still lose). */
function isTerminalDownload(status: LlmDownloadStatus): boolean {
  return status === 'ready' || status === 'error'
}
function isTerminalServer(state: LlmServerState): boolean {
  return state === 'ready' || state === 'failed'
}

/** Filters the catalog down to models actually downloaded and usable on
 *  this device (`status === 'ready'`). Used by the feature tabs' model
 *  dropdown (T4.2) so `on-device-llm` only ever offers models that are
 *  really on disk — never a preset suggestion string the user hasn't
 *  downloaded. */
export function getReadyLlmModels(
  catalog: OnDeviceLlmCatalogEntry[],
  states: Record<string, LlmModelState>,
): OnDeviceLlmCatalogEntry[] {
  return catalog.filter((entry) => states[entry.id]?.status === 'ready')
}

/** Map a backend wire download-state to the hook's local shape. */
function fromWireDownload(wire: OnDeviceLlmDownloadStateWire): LlmModelState {
  if (wire.status === 'downloading') return { status: 'downloading', progress: wire.progress }
  if (wire.status === 'error') return { status: 'error', code: wire.code }
  return { status: wire.status }
}

/** Map a backend wire server-state to the hook's local shape. */
function fromWireServer(wire: OnDeviceLlmServerStateWire): LlmServerStatus {
  if (wire.state === 'ready') return { state: 'ready', model_id: wire.model_id, port: wire.port }
  if (wire.state === 'failed') return { state: 'failed', code: wire.code }
  return { state: wire.state }
}

/** Build the per-model states map from the joined backend catalog. */
function statesFromCatalog(models: OnDeviceLlmModelWire[]): Record<string, LlmModelState> {
  const next: Record<string, LlmModelState> = {}
  for (const model of models) {
    next[model.id] = fromWireDownload(model.downloadState)
  }
  return next
}

/** Strip the live `downloadState` field off a wire entry to get the pure
 *  catalog metadata the picker renders. The wire is camelCase (backend
 *  `#[serde(rename_all = "camelCase")]`); the hook's internal
 *  `OnDeviceLlmCatalogEntry` stays snake_case for the picker, so this is
 *  also the camelCase→snake_case boundary. */
function toCatalogEntry(model: OnDeviceLlmModelWire): OnDeviceLlmCatalogEntry {
  return {
    id: model.id,
    display_name: model.displayName,
    download_size_bytes: model.downloadSizeBytes,
    context_tokens: model.contextTokens,
    min_ram_gb: model.minRamGb,
    recommended: model.recommended,
    multilingual: model.multilingual,
    when_to_choose: model.whenToChoose,
    terms_url: model.termsUrl ?? '',
    requires_acceptance: Boolean(model.requiresAcceptance),
  }
}

function receiptToAccepted(raw: string | null): boolean {
  return typeof raw === 'string' && raw.trim().length > 0
}

function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return String(e)
}

function isTermsNotAccepted(e: unknown): boolean {
  if (e instanceof TermsNotAcceptedError) return true
  return errorMessage(e).includes(TERMS_NOT_ACCEPTED_CODE)
}

/** Apply a binary-status poll without clobbering an in-flight download. */
function binaryStateFromStatus(installed: boolean, prev: LlmModelState): LlmModelState {
  if (installed) return { status: 'ready' }
  if (prev.status === 'downloading') return prev
  return NOT_DOWNLOADED
}

export function useOnDeviceLlmModels(): UseOnDeviceLlmModelsReturn {
  const [catalog, setCatalog] = useState<OnDeviceLlmCatalogEntry[]>([])
  const catalogRef = useRef<OnDeviceLlmCatalogEntry[]>([])
  const [states, setStates] = useState<Record<string, LlmModelState>>({})
  const [binaryState, setBinaryState] = useState<LlmModelState>(NOT_DOWNLOADED)
  const [serverStatus, setServerStatus] = useState<LlmServerStatus>(SERVER_STOPPED)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const termsAcceptedRef = useRef(false)

  const applyTermsAccepted = useCallback((value: boolean) => {
    termsAcceptedRef.current = value
    setTermsAccepted(value)
  }, [])

  const hydrate = useCallback(
    async (isCancelled?: () => boolean) => {
      try {
        const [models, server, receipt, binary] = await Promise.all([
          listOnDeviceLlmModels(),
          getOnDeviceLlmServerStatus(),
          getSetting(ON_DEVICE_LLM_TERMS_ACCEPTED_AT),
          onDeviceLlmBinaryStatus(),
        ])
        if (isCancelled?.()) return
        const nextCatalog = models.map(toCatalogEntry)
        const nextStates = statesFromCatalog(models)
        catalogRef.current = nextCatalog
        setCatalog(nextCatalog)
        setStates(nextStates)
        setServerStatus(fromWireServer(server))
        applyTermsAccepted(receiptToAccepted(receipt))
        setBinaryState((prev) => binaryStateFromStatus(binary.installed, prev))
        // Palette gate — `refresh()` calls hydrate, so any mounted instance feeds it.
        cacheReadyOnDevice('llm', getReadyLlmModels(nextCatalog, nextStates).length > 0)
      } catch (e) {
        console.warn('useOnDeviceLlmModels: hydrate failed', e)
      }
    },
    [applyTermsAccepted],
  )

  const refresh = useCallback(async () => {
    await hydrate()
  }, [hydrate])

  // Hydrate on mount.
  useEffect(() => {
    let cancelled = false
    void hydrate(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [hydrate])

  // Subscribe to download-progress + server-status events.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      try {
        const unProgress = await listen<OnDeviceLlmDownloadProgressEvent>(
          'on-device-llm:download-progress',
          (event) => {
            const { id, phase, state, progress, code } = event.payload
            // Binary phase routes into its own state slot — never the
            // per-model map (it would render as a phantom catalog row).
            if (phase === 'binary' || id === BINARY_PHASE_ID) {
              setBinaryState((prev) => {
                if (state === 'downloading' && isTerminalDownload(prev.status)) return prev
                if (state === 'downloading') return { status: 'downloading', progress }
                // A user-initiated cancel is NOT a failure — reset to
                // not_downloaded so the picker shows Download (not Retry) and
                // no "failed" line.
                if (state === 'error' && code === CANCELLED_CODE)
                  return { status: 'not_downloaded' }
                if (state === 'error') return { status: 'error', code }
                return { status: 'ready' }
              })
              // A REAL binary-phase failure aborts the whole download — the
              // model (Phase 2) never runs, so any model left in the optimistic
              // `downloading` state would otherwise stay stuck at 0% forever.
              // Flip those to `error` so the card reflects the real failure.
              // A cancel is intentional, so it must NOT turn models into errors.
              if (state === 'error' && code !== CANCELLED_CODE) {
                setStates((prev) => {
                  let changed = false
                  const next = { ...prev }
                  for (const [modelId, s] of Object.entries(prev)) {
                    if (s.status === 'downloading') {
                      next[modelId] = { status: 'error', code: code ?? 'on_device_engine_failed' }
                      changed = true
                    }
                  }
                  return changed ? next : prev
                })
              }
              return
            }
            setStates((prev) => {
              const current = prev[id]?.status
              // Terminal-state defense: a late downloading tick must not
              // clobber a just-landed ready/error.
              if (state === 'downloading' && current && isTerminalDownload(current)) {
                return prev
              }
              if (state === 'downloading') {
                return { ...prev, [id]: { status: 'downloading', progress } }
              }
              if (state === 'error') {
                // Cancel is intentional — surface it as not_downloaded, not a
                // "Download failed" error with a Retry button.
                return {
                  ...prev,
                  [id]:
                    code === CANCELLED_CODE
                      ? { status: 'not_downloaded' }
                      : { status: 'error', code },
                }
              }
              return { ...prev, [id]: { status: 'ready' } }
            })
          },
        )
        if (cancelled) {
          unProgress()
          return
        }
        unlisteners.push(unProgress)

        const unServer = await listen<OnDeviceLlmServerStatusEvent>(
          'on-device-llm:server-status',
          (event) => {
            const { state, model_id, port, code } = event.payload
            setServerStatus((prev) => {
              // Terminal-state defense: a late starting tick must not
              // clobber a just-landed ready/failed.
              if (state === 'starting' && isTerminalServer(prev.state)) return prev
              if (state === 'ready') {
                return { state: 'ready', model_id, port }
              }
              if (state === 'failed') {
                return { state: 'failed', code }
              }
              // stopped / starting
              return { state }
            })
          },
        )
        if (cancelled) {
          unServer()
          return
        }
        unlisteners.push(unServer)

        const unRemoved = await listen<{ id: string; kind: 'embed' | 'llm' }>(
          'ai:model-removed',
          (event) => {
            const { id, kind } = event.payload
            if (kind !== 'llm') return
            setStates((prev) => {
              const next = { ...prev, [id]: { status: 'not_downloaded' as const } }
              cacheReadyOnDevice('llm', getReadyLlmModels(catalogRef.current, next).length > 0)
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
        console.warn('useOnDeviceLlmModels: subscribe failed', e)
      }
    }

    void subscribe()
    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [])

  const download = useCallback(
    async (id: string) => {
      const entry = catalog.find((m) => m.id === id)
      if (entry?.requires_acceptance && !termsAcceptedRef.current) {
        throw new TermsNotAcceptedError()
      }
      setStates((prev) => ({ ...prev, [id]: { status: 'downloading', progress: 0 } }))
      try {
        await downloadOnDeviceLlmModel(id)
      } catch (e) {
        if (isTermsNotAccepted(e)) {
          setStates((prev) => ({
            ...prev,
            [id]: { status: 'error', code: TERMS_NOT_ACCEPTED_CODE },
          }))
          throw e instanceof TermsNotAcceptedError ? e : new TermsNotAcceptedError()
        }
        throw e
      }
    },
    [catalog],
  )

  const acceptTerms = useCallback(async () => {
    await setSetting(ON_DEVICE_LLM_TERMS_ACCEPTED_AT, new Date().toISOString())
    applyTermsAccepted(true)
  }, [applyTermsAccepted])

  const cancelDownload = useCallback(async (id: string) => {
    try {
      await cancelOnDeviceLlmDownload(id)
      setStates((prev) => ({ ...prev, [id]: { status: 'not_downloaded' } }))
    } catch (e) {
      console.warn('useOnDeviceLlmModels: cancel failed', e)
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    // Other delete errors still propagate; `"model_in_use"` is no longer
    // a blocker — the backend teardowns then deletes.
    await deleteOnDeviceLlmModel(id)
    setStates((prev) => {
      const next = { ...prev, [id]: { status: 'not_downloaded' as const } }
      cacheReadyOnDevice('llm', getReadyLlmModels(catalogRef.current, next).length > 0)
      return next
    })
  }, [])

  const removeBinary = useCallback(async () => {
    await deleteOnDeviceLlmBinary()
    setBinaryState(NOT_DOWNLOADED)
  }, [])

  return {
    catalog,
    states,
    binaryState,
    serverStatus,
    download,
    cancelDownload,
    remove,
    removeBinary,
    refresh,
    termsAccepted,
    acceptTerms,
  }
}
