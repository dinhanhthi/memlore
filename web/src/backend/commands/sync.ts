/**
 * Sync commands, status events and the pull schedule (Phase 10.4). READ-ONLY: the web has no local
 * push queue yet (Phase 16), so every "pull" here is `ReadSession.pull()` and `entriesPending` is 0.
 *
 * Desktop contract followed here (src-tauri/src/commands/sync.rs, src/lib/tauri.ts):
 *   Event  "sync:status-changed" `{state, enabled, configured, provider, lastSync, entriesPending,
 *          error}`, `state` is `'idle' | 'syncing' | 'synced' | 'error'` (there is no "offline" or
 *          "incompatible" phase: both are `error` with a message). A clean run ends in `synced`.
 *          `lastSync` is Unix SECONDS. `provider` is `'gdrive'` (CloudProviderKind), never
 *          "google_drive".
 *   Event  "memlore:entries-changed" (window CustomEvent + shim, through the 10.3 emitter) after a
 *          pull whose result differs from what was shown; never after a no-op pull.
 *   Event  "sync:progress" is deliberately NOT emitted: the UI treats every `pulling-*` tick as
 *          "rows are landing" and refetches all lists, which a no-op pull must not trigger. The
 *          lists refresh through the two events above (and syncStore does it on `synced` anyway).
 *   Cmd    sync_now -> SyncSummary `{pushed, pulled, merged, errors}`. A pull failure is reported in
 *          `errors` (the store reads `summary.errors`), it does not reject. Locked: rejects.
 *   Cmd    get_sync_status -> SyncStatus; get_sync_settings -> SyncSettings `{intervalMinutes,
 *          onSave, onLaunch}`, which has no provider field: "Drive only, iCloud unavailable" is
 *          `provider: 'gdrive'` here and in `gdrive_get_status`, plus the `icloud_availability`
 *          default (`available: false`). Locked: the pre-unlock defaults, like the desktop's
 *          placeholder database.
 *
 * SCHEDULE (`startSyncSchedule`, started by `app:unlocked`, stopped by the key holder's lock hook):
 *   - a pull at start, on window focus and when the tab becomes visible again if the last ATTEMPT
 *     is older than 30 s, and every 5 min while visible. Never while the tab is hidden.
 *   - one pull at a time: every trigger (and `sync_now`) joins the one in flight.
 *   - a failure backs off 30 s, 60 s, ... up to 5 min (counted from the last attempt, so a failing
 *     vault is not retried on every focus). `sync_now` resets the backoff, like the desktop.
 *   - `ReonboardRequiredError` (the puller already dropped the ciphertext and locked) and
 *     `FormatUnsupportedError` (this build cannot read the vault) halt the schedule until the next
 *     unlock: error status with the message, no retries. There is no web UI for re-onboarding yet
 *     (Phase 12), so only the status and the puller's `getReonboardReason()` flag carry the signal;
 *     the desktop's `xj://force-re-pair` event routes to screens whose commands are unsupported.
 *
 * Errors are told apart by `name`, not `instanceof`: importing the puller or onboard module here
 * would drag the WASM core into the router bundle (this file is imported statically by router.ts).
 */

import { emitFromBackend, listen } from '../../tauri/event'
import { ERROR_NAMES } from '../errorNames'
import { VaultLockedError, isUnlocked, onLock } from '../keys'
import type { Handler } from '../router'
import { readEnv, type PullOutcome } from './readSession'

export const STATUS_EVENT = 'sync:status-changed'
const CHANGED_EVENT = 'memlore:entries-changed'

export const FOCUS_MIN_AGE_MS = 30_000
export const INTERVAL_MS = 5 * 60_000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 5 * 60_000

export const MSG_FORMAT_READ_ONLY =
  'This vault uses a newer sync format than this app version understands, so it stays read-only. Update the app.'

export type SyncPhase = 'idle' | 'syncing' | 'synced' | 'error'

export interface SyncStatus {
  enabled: boolean
  configured: boolean
  provider: string | null
  lastSync: number | null
  entriesPending: number
}

export interface SyncStatusEvent extends SyncStatus {
  state: SyncPhase
  error: string | null
}

export interface SyncSummary {
  pushed: number
  pulled: number
  merged: number
  errors: string[]
}

interface Target {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}
interface DocumentLike extends Target {
  visibilityState: string
}

/** Injectable environment. Defaults resolve lazily so importing has no side effects. */
export interface SyncEnv {
  /** Unix milliseconds. */
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  emit: (event: string, payload?: unknown) => void
  /** `memlore:entries-changed`, through the read session's emitter (shim + window event). */
  emitChanged: () => void
  isUnlocked: () => boolean
  /** One pull of the read session. */
  pull: () => Promise<PullOutcome>
  document: DocumentLike | null
  window: Target | null
}

function defaultEnv(): SyncEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    emit: emitFromBackend,
    emitChanged: () => readEnv().emit(CHANGED_EVENT),
    isUnlocked,
    pull: async () => (await readEnv().session()).pull(),
    document: typeof document === 'undefined' ? null : (document as unknown as DocumentLike),
    window: typeof window === 'undefined' ? null : (window as unknown as Target),
  }
}

let injected: Partial<SyncEnv> = {}
const env = (): SyncEnv => ({ ...defaultEnv(), ...injected })

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface PullReport {
  outcome: PullOutcome | null
  /** Set when the pull failed. */
  message: string | null
}

let phase: SyncPhase = 'idle'
let lastError: string | null = null
/** Unix seconds of the last successful pull. */
let lastSyncSec: number | null = null
/** The pull in flight, tagged with the schedule epoch it started under. */
let inflight: { epoch: number; promise: Promise<PullReport> } | null = null
let lastAttemptAt = 0
let nextAttemptAt = 0
let failures = 0
let halted = false
let active: { stop: () => void } | null = null
let retryTimer: unknown = null
/** Bumped on stop: a pull that finishes under an older epoch reports nothing. */
let epoch = 0
let autostartInstalled = false

/** Test seam: override injected pieces and reset all state. Pass `{}` to restore the defaults. */
export function configureSyncEnv(partial: Partial<SyncEnv>): void {
  stopSyncSchedule()
  injected = partial
  phase = 'idle'
  lastError = null
  lastSyncSec = null
  inflight = null
  lastAttemptAt = 0
  nextAttemptAt = 0
  failures = 0
  halted = false
}

const snapshot = (): SyncStatus => ({
  enabled: true,
  configured: true,
  provider: 'gdrive',
  lastSync: lastSyncSec,
  entriesPending: 0,
})

function setPhase(next: SyncPhase, error: string | null): void {
  phase = next
  lastError = error
  const payload: SyncStatusEvent = { ...snapshot(), state: next, error }
  env().emit(STATUS_EVENT, payload)
}

// ---------------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------------

function backoffMs(count: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, count - 1))
}

function clearRetry(): void {
  if (retryTimer !== null) env().clearTimeout(retryTimer)
  retryTimer = null
}

function isHidden(e: SyncEnv): boolean {
  return e.document?.visibilityState === 'hidden'
}

/**
 * One pull at a time: a caller while one is in flight gets that one's report. A pull that started
 * under an older epoch (before a lock) is never joined: it reports nothing and must not swallow the
 * start of the new schedule.
 */
function runPull(): Promise<PullReport> {
  if (inflight !== null && inflight.epoch === epoch) return inflight.promise
  const entry: { epoch: number; promise: Promise<PullReport> } = {
    epoch,
    promise: doPull().finally(() => {
      if (inflight === entry) inflight = null
    }),
  }
  inflight = entry
  return entry.promise
}

async function doPull(): Promise<PullReport> {
  const e = env()
  const startedEpoch = epoch
  lastAttemptAt = e.now()
  setPhase('syncing', null)
  try {
    const outcome = await e.pull()
    if (startedEpoch !== epoch) return { outcome: null, message: null }
    failures = 0
    nextAttemptAt = 0
    clearRetry()
    lastSyncSec = Math.floor(e.now() / 1000)
    setPhase('synced', null)
    if (outcome.changed) e.emitChanged()
    return { outcome, message: null }
  } catch (error: unknown) {
    return fail(error, startedEpoch)
  }
}

function fail(error: unknown, startedEpoch: number): PullReport {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === ERROR_NAMES.reonboardRequired) {
    // The puller locked the vault (which stopped the schedule) before throwing: still report it.
    halted = true
    clearRetry()
    setPhase('error', message)
    return { outcome: null, message }
  }
  if (name === ERROR_NAMES.vaultLocked || startedEpoch !== epoch) {
    // Locked mid-pull: the lock hook already tore everything down.
    phase = 'idle'
    return { outcome: null, message: null }
  }
  if (name === ERROR_NAMES.formatUnsupported) {
    const text = `${MSG_FORMAT_READ_ONLY} (${message})`
    halted = true
    clearRetry()
    setPhase('error', text)
    return { outcome: null, message: text }
  }
  failures += 1
  const delay = backoffMs(failures)
  nextAttemptAt = env().now() + delay
  setPhase('error', message)
  scheduleRetry(delay)
  return { outcome: null, message }
}

function scheduleRetry(delay: number): void {
  clearRetry()
  if (active === null) return
  retryTimer = env().setTimeout(() => {
    retryTimer = null
    request('retry')
  }, delay)
}

type Trigger = 'start' | 'focus' | 'interval' | 'retry'

/** A scheduled pull. Every guard lives here so no trigger can bypass one. */
function request(trigger: Trigger): void {
  const e = env()
  if (active === null || halted || !e.isUnlocked() || isHidden(e)) return
  if (e.now() < nextAttemptAt) return
  if (trigger === 'focus' && e.now() - lastAttemptAt < FOCUS_MIN_AGE_MS) return
  void runPull()
}

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

/** Stops the schedule: timers, listeners and the lock hook. An in-flight pull reports nothing. */
export function stopSyncSchedule(): void {
  const current = active
  if (current === null) return
  active = null
  epoch += 1
  clearRetry()
  current.stop()
}

/** Starts the schedule (after a successful unlock). Restarts it when already running. */
export function startSyncSchedule(): void {
  stopSyncSchedule()
  const e = env()
  halted = false
  failures = 0
  nextAttemptAt = 0
  lastAttemptAt = 0
  if (phase === 'error') setPhase('idle', null)

  const onFocus = (): void => request('focus')
  const onVisibility = (): void => {
    if (!isHidden(e)) request('focus')
  }
  let timer: unknown = null
  const tick = (): void => {
    timer = e.setTimeout(() => {
      request('interval')
      if (active !== null) tick()
    }, INTERVAL_MS)
  }
  e.window?.addEventListener('focus', onFocus)
  e.document?.addEventListener('visibilitychange', onVisibility)
  const unregisterLock = onLock(() => stopSyncSchedule())
  active = {
    stop: () => {
      e.window?.removeEventListener('focus', onFocus)
      e.document?.removeEventListener('visibilitychange', onVisibility)
      if (timer !== null) e.clearTimeout(timer)
      unregisterLock()
      if (phase === 'syncing') phase = 'idle'
    },
  }
  tick()
  request('start')
}

/** Wires `app:unlocked` (emitted by auth after a successful unlock or onboarding). Idempotent. */
export function installSyncAutostart(): void {
  if (autostartInstalled) return
  autostartInstalled = true
  void listen('app:unlocked', () => startSyncSchedule())
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

const LOCKED_STATUS: SyncStatus = {
  enabled: false,
  configured: false,
  provider: null,
  lastSync: null,
  entriesPending: 0,
}

async function syncNow(): Promise<SyncSummary> {
  if (!env().isUnlocked()) throw new VaultLockedError()
  // The user intervened: reset the backoff and a format halt (a retry is the point), like the
  // desktop's `reset_backoff`.
  failures = 0
  nextAttemptAt = 0
  if (retryTimer !== null) clearRetry()
  if (halted && lastError?.startsWith(MSG_FORMAT_READ_ONLY)) halted = false
  const report = await runPull()
  return {
    pushed: 0,
    pulled: report.outcome?.stale.length ?? 0,
    merged: 0,
    errors: report.message === null ? [] : [report.message],
  }
}

async function getSyncStatus(): Promise<SyncStatus> {
  return env().isUnlocked() ? snapshot() : LOCKED_STATUS
}

/** Web has no sync scheduler settings to edit; the 5 min pull interval is fixed (see above). */
async function getSyncSettings(): Promise<{
  intervalMinutes: number
  onSave: boolean
  onLaunch: boolean
}> {
  return { intervalMinutes: INTERVAL_MS / 60_000, onSave: false, onLaunch: true }
}

/** Connected = a Drive session exists AND this browser is enrolled (a device record exists). */
async function gdriveGetStatus(): Promise<{
  connected: boolean
  provider?: string
  lastSync?: number
}> {
  try {
    const [{ oauth }, { openWebDb }] = await Promise.all([
      import('../drive/oauth'),
      import('../storage/idb'),
    ])
    if (!oauth.isConnected()) return { connected: false }
    if ((await (await openWebDb()).device.get()) === undefined) return { connected: false }
    return {
      connected: true,
      provider: 'gdrive',
      ...(lastSyncSec === null ? {} : { lastSync: lastSyncSec }),
    }
  } catch {
    return { connected: false }
  }
}

export const syncHandlers: Record<string, Handler> = {
  sync_now: syncNow,
  get_sync_status: getSyncStatus,
  get_sync_settings: getSyncSettings,
  gdrive_get_status: gdriveGetStatus,
}
