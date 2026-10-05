/**
 * Sync commands, status events, the pull schedule (Phase 10.4) and the push triggers (Phase 16.5).
 * A "pull" here is `ReadSession.pull()`; a "push" is `pushAll()` (sync/push.ts), which uploads the
 * unpushed drafts to this device's outbox. `entriesPending` is the unpushed draft count.
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
 *   Cmd    sync_now -> SyncSummary `{pushed, pulled, merged, errors}`: a pull, then (cached write
 *          flag on) a push. A pull or push failure is reported in `errors` (the store reads
 *          `summary.errors`), it does not reject. Locked: rejects.
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
 *   - a pull that SUCCEEDS with the format guard latched (`PullOutcome.formatReadOnly`: a newer
 *     manifest, envelope or entry metadata was read) keeps the schedule running (reads go on) but
 *     shows `MSG_FORMAT_READ_ONLY` on the `synced` status and stops automatic pushes.
 *
 * PUSH (only while the schedule runs, i.e. unlocked, and only when the cached write flag is on;
 * `safeUpload` re-fetches the flag before any write):
 *   - every automatic push waits for the FIRST successful pull of the schedule (`pulledThisEpoch`):
 *     the pull is the revocation check, and with a primed read session a save can now precede it.
 *     The first success pushes pending drafts itself, whatever trigger ran that pull.
 *   - `PUSH_DEBOUNCE_MS` after the last `saveDraft` (the drafts notifier, one hook for every write
 *     command), when the tab becomes visible, when the browser comes back `online`, and after
 *     every interval pull when drafts are pending. The unlock pull hydrates the
 *     read session, which refreshes the dirty set. The write flag is fetched on the same
 *     `app:unlocked` and may land after that pull: the interval pull then catches those drafts.
 *   - `sync_now` pulls FIRST, then pushes, and skips the push when the pull failed. The pull is what
 *     detects a revoked device (`slot-missing`), which the write fence does not check: pushing first
 *     could upload to an outbox the desktop already revoked. A revoke never touches drafts
 *     (`clearCache` keeps them), so pulling first loses nothing.
 *   - A push error is the `error` status with its message and backs off 30 s, 60 s, ... 5 min on its
 *     own counter (a failing push must not starve pulls); the retry pushes again, `online` skips the
 *     wait, a successful push clears the error. A successful pull keeps a push error on screen.
 *   - A push emits a status only when it fails, clears its own error, or changes `entriesPending`:
 *     never `syncing` / a fresh `synced` per save (the store refetches every list on `synced`).
 *
 * Errors are told apart by `name`, not `instanceof`: importing the puller or onboard module here
 * would drag the WASM core into the router bundle (this file is imported statically by router.ts).
 * For the same reason push.ts is only ever imported dynamically.
 */

import { emitFromBackend, listen } from '../../tauri/event'
import { getCachedWriteFlag, onWriteFlagOn } from '../config'
import { onDraftSaved, unpushedDraftCount } from '../drafts'
import { ERROR_NAMES } from '../errorNames'
import { VaultLockedError, isUnlocked, onLock } from '../keys'
import type { Handler } from '../router'
import type { PushResult } from '../sync/push'
import { readEnv, type PullOutcome } from './readSession'

export const STATUS_EVENT = 'sync:status-changed'
const CHANGED_EVENT = 'memlore:entries-changed'

export const FOCUS_MIN_AGE_MS = 30_000
export const INTERVAL_MS = 5 * 60_000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 5 * 60_000
export const PUSH_DEBOUNCE_MS = 2_000

export const MSG_FORMAT_READ_ONLY =
  'This vault uses a newer sync format than this app version understands, so it stays read-only. Update the app.'

/**
 * Shown (as the status `error` of a `synced` phase) when a device's data could not be read fully.
 * Intent-retention notices (`PullOutcome.notices`) use the same channel, merged into one note, once.
 */
export const MSG_SYNC_DEGRADED = "sync degraded: a device's data could not be read fully"

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
  /** `pushAll()`, imported lazily (push.ts loads the WASM core). Never rejects. */
  push: () => Promise<PushResult>
  /** The last fetched write flag. Off: no push at all. */
  cachedWriteFlag: () => boolean
  /** Subscribes to the cached flag turning on; returns the unsubscribe function. */
  onWriteFlagOn: (listener: () => void) => () => void
  /** The unpushed draft count, without reading IndexedDB. */
  pendingCount: () => number
  /** Subscribes to every successful `saveDraft`; returns the unsubscribe function. */
  onDraftSaved: (listener: () => void) => () => void
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
    push: async () => (await import('../sync/push')).pushAll(),
    cachedWriteFlag: getCachedWriteFlag,
    onWriteFlagOn,
    pendingCount: unpushedDraftCount,
    onDraftSaved,
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
/**
 * Last Drive account snapshot from `gdrive_refresh_storage_quota`. Session memory,
 * like the desktop settings cache: a later `gdrive_get_status` can paint it before
 * the next live fetch. Cleared when the Drive session is gone.
 */
let storageCache: {
  email?: string
  storageUsed?: number
  storageTotal?: number
  storageAppUsed?: number
} = {}
/** Set while the last successful pull left a device on its cached manifest. */
let degraded = false
/** `MSG_FORMAT_READ_ONLY` with the reason, while the last successful pull reported a latched guard. */
let formatReadOnly: string | null = null

/** The note a successful pull shows: read-only wins over degraded. */
const pullNote = (): string | null => formatReadOnly ?? (degraded ? MSG_SYNC_DEGRADED : null)
/**
 * Intent-retention notices of every pull, oldest first, until a `synced` status carries them once
 * (merged into one note in `error`, like `MSG_SYNC_DEGRADED`). An error status leaves them queued.
 * Memory only: a lock or restart drops them, and they are not shown again after a reload because
 * retention already persisted them as shown before returning them.
 */
let pendingNotices: string[] = []

/** The first notice, plus how many more were queued with it. */
function mergeNotices(notices: string[]): string {
  const more = notices.length - 1
  if (more === 0) return notices[0]
  return `${notices[0]} (and ${more} more ${more === 1 ? 'edit' : 'edits'})`
}
/** The pull in flight, tagged with the schedule epoch it started under. */
let inflight: { epoch: number; promise: Promise<PullReport> } | null = null
let lastAttemptAt = 0
let nextAttemptAt = 0
let failures = 0
let halted = false
/** Pushes need a re-onboard (`MissingVaultStateError`): no automatic push until the next unlock. */
let pushHalted = false
/**
 * The revocation check of this schedule's epoch ran: until the first successful pull, automatic
 * pushes stay gated (a primed read session lets a save land before that pull).
 */
let pulledThisEpoch = false
let active: { stop: () => void } | null = null
let retryTimer: unknown = null
/** Bumped on stop: a pull that finishes under an older epoch reports nothing. */
let epoch = 0
let autostartInstalled = false
/** Push backoff, apart from the pull's so a failing push never blocks pulls. */
let pushFailures = 0
let pushNextAt = 0
let pushRetryTimer: unknown = null
/** The last push error, until a push succeeds. A successful pull keeps showing it. */
let pushError: string | null = null
/** `entriesPending` of the last status event. */
let reportedPending = 0
/** The last push result reported: `pushAll` resolves every joiner of a run to the same object. */
let lastReported: PushResult | null = null

/** Test seam: override injected pieces and reset all state. Pass `{}` to restore the defaults. */
export function configureSyncEnv(partial: Partial<SyncEnv>): void {
  stopSyncSchedule()
  injected = partial
  phase = 'idle'
  lastError = null
  lastSyncSec = null
  storageCache = {}
  degraded = false
  formatReadOnly = null
  pendingNotices = []
  inflight = null
  lastAttemptAt = 0
  nextAttemptAt = 0
  failures = 0
  halted = false
  pulledThisEpoch = false
  pushFailures = 0
  pushNextAt = 0
  pushError = null
  reportedPending = 0
  lastReported = null
}

const snapshot = (): SyncStatus => {
  const e = env()
  return {
    enabled: true,
    configured: true,
    provider: 'gdrive',
    lastSync: lastSyncSec,
    entriesPending: e.isUnlocked() ? e.pendingCount() : 0,
  }
}

function setPhase(next: SyncPhase, error: string | null): void {
  // A push error survives a pull that succeeds: the drafts are still not uploaded.
  const keepPushError = next === 'synced' && pushError !== null
  phase = keepPushError ? 'error' : next
  lastError = keepPushError ? pushError : error
  // A notice rides on one `synced` status only; `lastError` keeps the note it replaced.
  let shown = lastError
  if (phase === 'synced' && pendingNotices.length > 0) {
    shown = mergeNotices(pendingNotices)
    pendingNotices = []
  }
  const payload: SyncStatusEvent = { ...snapshot(), state: phase, error: shown }
  reportedPending = payload.entriesPending
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
    const firstPull = !pulledThisEpoch
    pulledThisEpoch = true
    failures = 0
    nextAttemptAt = 0
    clearRetry()
    lastSyncSec = Math.floor(e.now() / 1000)
    degraded = (outcome.degraded?.length ?? 0) > 0
    formatReadOnly =
      outcome.formatReadOnly === undefined
        ? null
        : `${MSG_FORMAT_READ_ONLY} (${outcome.formatReadOnly})`
    // Reads go on; every write is refused until reload, so no automatic push is attempted.
    if (formatReadOnly !== null) pushHalted = true
    pendingNotices.push(...(outcome.notices ?? []))
    setPhase('synced', pullNote())
    if (outcome.changed) e.emitChanged()
    // The revocation check just ran: drafts saved before it (a primed session writes at once) or
    // while the write flag was still unfetched go out now. `requestPush` still applies its guards.
    if (firstPull && e.pendingCount() > 0) requestPush('start')
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
  const pulling = runPull()
  if (trigger !== 'interval') return
  // Interval pulls only: a successful start pull is always the epoch's first, so `doPull` already
  // pushed pending drafts itself. The interval still catches drafts the unlock pull missed because
  // the write flag was not fetched yet.
  void pulling.then((report) => {
    if (report.message === null && report.outcome !== null && env().pendingCount() > 0) {
      requestPush('start')
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------------

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function clearPushRetry(): void {
  if (pushRetryTimer !== null) env().clearTimeout(pushRetryTimer)
  pushRetryTimer = null
}

function resetPushBackoff(): void {
  pushFailures = 0
  pushNextAt = 0
  clearPushRetry()
}

type PushTrigger = 'start' | 'save' | 'visible' | 'online' | 'retry'

/** An automatic push. `online` skips the backoff wait: the network being back is the point. */
function requestPush(trigger: PushTrigger): void {
  const e = env()
  if (
    active === null ||
    halted ||
    pushHalted ||
    !pulledThisEpoch ||
    !e.isUnlocked() ||
    !e.cachedWriteFlag()
  )
    return
  if (trigger !== 'online' && e.now() < pushNextAt) return
  void runPush()
}

/** One `pushAll()`; its result is reported once even when several callers join the same run. */
function runPush(): Promise<PushResult> {
  const startedEpoch = epoch
  return env()
    .push()
    .then((result) => {
      if (result !== lastReported) {
        lastReported = result
        reportPush(result, startedEpoch)
      }
      return result
    })
}

function reportPush(result: PushResult, startedEpoch: number): void {
  const e = env()
  const name = result.error instanceof Error ? result.error.name : ''
  if (name === ERROR_NAMES.reonboardRequired) {
    // A fence refusal re-validated through the puller, which locked: still report it, like a pull.
    halted = true
    clearRetry()
    resetPushBackoff()
    setPhase('error', errorText(result.error))
    return
  }
  if (startedEpoch !== epoch || !e.isUnlocked() || name === ERROR_NAMES.vaultLocked) return
  if (name === ERROR_NAMES.missingVaultState || name === ERROR_NAMES.formatUnsupported) {
    // Retrying cannot help until the user re-onboards (or updates the app, for a latched format
    // guard); reads and pulls keep working.
    pushHalted = true
    resetPushBackoff()
    pushError =
      name === ERROR_NAMES.formatUnsupported
        ? `${MSG_FORMAT_READ_ONLY} (${errorText(result.error)})`
        : errorText(result.error)
    setPhase('error', pushError)
    return
  }
  if (result.error !== undefined) {
    pushFailures += 1
    const delay = backoffMs(pushFailures)
    pushNextAt = e.now() + delay
    pushError = errorText(result.error)
    setPhase('error', pushError)
    schedulePushRetry(delay)
    return
  }
  resetPushBackoff()
  if (pushError !== null) {
    const shown = lastError === pushError
    pushError = null
    if (shown) {
      setPhase('synced', pullNote())
      return
    }
  }
  if (e.pendingCount() !== reportedPending) setPhase(phase, lastError)
}

function schedulePushRetry(delay: number): void {
  clearPushRetry()
  if (active === null) return
  pushRetryTimer = env().setTimeout(() => {
    pushRetryTimer = null
    requestPush('retry')
  }, delay)
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
  clearPushRetry()
  current.stop()
}

/** Starts the schedule (after a successful unlock). Restarts it when already running. */
export function startSyncSchedule(): void {
  stopSyncSchedule()
  const e = env()
  halted = false
  pushHalted = false
  pulledThisEpoch = false
  failures = 0
  nextAttemptAt = 0
  lastAttemptAt = 0
  degraded = false
  formatReadOnly = null
  pendingNotices = []
  pushFailures = 0
  pushNextAt = 0
  pushError = null
  if (phase === 'error') setPhase('idle', null)

  const onFocus = (): void => request('focus')
  const onVisibility = (): void => {
    if (isHidden(e)) return
    request('focus')
    requestPush('visible')
  }
  const onOnline = (): void => requestPush('online')
  let debounce: unknown = null
  const onSaved = (): void => {
    if (debounce !== null) e.clearTimeout(debounce)
    debounce = e.setTimeout(() => {
      debounce = null
      requestPush('save')
    }, PUSH_DEBOUNCE_MS)
  }
  let timer: unknown = null
  const tick = (): void => {
    timer = e.setTimeout(() => {
      request('interval')
      if (active !== null) tick()
    }, INTERVAL_MS)
  }
  e.window?.addEventListener('focus', onFocus)
  e.window?.addEventListener('online', onOnline)
  e.document?.addEventListener('visibilitychange', onVisibility)
  const unsubscribeSaved = e.onDraftSaved(onSaved)
  // The flag is fetched on the same unlock event as the first pull and may land after it.
  const unsubscribeFlag = e.onWriteFlagOn(() => {
    if (e.pendingCount() > 0) requestPush('start')
  })
  const unregisterLock = onLock(() => stopSyncSchedule())
  active = {
    stop: () => {
      e.window?.removeEventListener('focus', onFocus)
      e.window?.removeEventListener('online', onOnline)
      e.document?.removeEventListener('visibilitychange', onVisibility)
      unsubscribeSaved()
      unsubscribeFlag()
      if (timer !== null) e.clearTimeout(timer)
      if (debounce !== null) e.clearTimeout(debounce)
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
  const e = env()
  if (!e.isUnlocked()) throw new VaultLockedError()
  // The user intervened: reset the backoff and a format halt (a retry is the point), like the
  // desktop's `reset_backoff`.
  failures = 0
  nextAttemptAt = 0
  if (retryTimer !== null) clearRetry()
  resetPushBackoff()
  if (halted && lastError?.startsWith(MSG_FORMAT_READ_ONLY)) halted = false
  const report = await runPull()
  const errors = report.message === null ? [] : [report.message]
  // Pull first (see the header): it detects a revoke before anything is written.
  let pushed = 0
  if (report.outcome !== null && e.isUnlocked() && e.cachedWriteFlag()) {
    const result = await runPush()
    pushed = result.pushed
    if (result.error !== undefined) errors.push(errorText(result.error))
  }
  return {
    pushed,
    pulled: report.outcome?.stale.length ?? 0,
    merged: 0,
    errors,
  }
}

async function getSyncStatus(): Promise<SyncStatus & { error?: string }> {
  if (!env().isUnlocked()) return LOCKED_STATUS
  // `SyncStatus` has no message field (only the event does): `error` is added only when degraded
  // or read-only.
  const note = pullNote()
  return note === null ? snapshot() : { ...snapshot(), error: note }
}

/** Web has no sync scheduler settings to edit; the 5 min pull interval is fixed (see above). */
async function getSyncSettings(): Promise<{
  intervalMinutes: number
  onSave: boolean
  onLaunch: boolean
}> {
  return { intervalMinutes: INTERVAL_MS / 60_000, onSave: false, onLaunch: true }
}

interface GDriveStatus {
  connected: boolean
  provider?: string
  lastSync?: number
  email?: string
  storageUsed?: number
  storageTotal?: number
  storageAppUsed?: number
}

function connectedDriveStatus(): GDriveStatus {
  return {
    connected: true,
    provider: 'gdrive',
    ...(lastSyncSec === null ? {} : { lastSync: lastSyncSec }),
    ...storageCache,
  }
}

/** Connected = a Drive session exists AND this browser is enrolled (a device record exists). */
async function gdriveGetStatus(): Promise<GDriveStatus> {
  try {
    const [{ oauth }, { openWebDb }] = await Promise.all([
      import('../drive/oauth'),
      import('../storage/idb'),
    ])
    if (!oauth.isConnected()) {
      storageCache = {}
      return { connected: false }
    }
    if ((await (await openWebDb()).device.get()) === undefined) return { connected: false }
    return connectedDriveStatus()
  } catch {
    return { connected: false }
  }
}

/**
 * Live account email, Drive quota, and bytes Memlore occupies in appDataFolder.
 * Mirrors desktop `gdrive_refresh_storage_quota`: `about` must succeed or the
 * previous cache is left untouched; a failed file-size sum keeps the last
 * Memlore usage. Rejects when this browser is not connected, so the settings
 * panel keeps the snapshot it already painted.
 */
async function gdriveRefreshStorageQuota(): Promise<GDriveStatus> {
  const status = await gdriveGetStatus()
  if (!status.connected) throw new Error('Not connected to Google Drive')
  const [{ DriveReader }, { oauth }] = await Promise.all([
    import('../drive/client'),
    import('../drive/oauth'),
  ])
  const reader = new DriveReader({ getToken: () => oauth.getAccessToken() })
  const about = await reader.fetchDriveAbout()
  let appUsed = storageCache.storageAppUsed
  try {
    appUsed = await reader.fetchAppdataUsageBytes()
  } catch (error) {
    console.warn(
      `[web] gdrive_refresh_storage_quota: appdata usage sum failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const next = { ...storageCache }
  if (about.email) next.email = about.email
  if (about.usage != null) next.storageUsed = about.usage
  if (about.limit != null) next.storageTotal = about.limit
  if (appUsed != null) next.storageAppUsed = appUsed
  storageCache = next
  return connectedDriveStatus()
}

export const syncHandlers: Record<string, Handler> = {
  sync_now: syncNow,
  get_sync_status: getSyncStatus,
  get_sync_settings: getSyncSettings,
  gdrive_get_status: gdriveGetStatus,
  gdrive_refresh_storage_quota: gdriveRefreshStorageQuota,
}
