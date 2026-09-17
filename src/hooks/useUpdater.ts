import { invoke } from '@tauri-apps/api/core'
import { useMemo, useSyncExternalStore } from 'react'
import { useUiStore } from '../stores/uiStore'
import { flushTabSession } from './useTabSessionRestore'

/**
 * In-app updater state machine, shared by every caller: the once-per-launch
 * silent check, the `Memlore > Check For Updates…` menu item and
 * `UpdateAvailableModal`.
 *
 * Only `invoke` is used — never `@tauri-apps/plugin-updater`. Both
 * `website/vite.config.ts` and `web/vite.config.ts` throw on any
 * `@tauri-apps/*` import outside their small aliased set, so importing the
 * plugin would break the demo and web-harness builds.
 */

/** Mirrors `UpdateInfo` in `src-tauri/src/commands/updater.rs` — `pub_date` is
 *  snake_case there and RFC 3339. */
export interface UpdateInfo {
  version: string
  notes: string | null
  pub_date: string | null
}

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  /** The *check* failed — a network problem in practice. */
  | 'error'
  /** Download, signature verification or swap failed. Kept apart from
   *  `'error'`: telling the user to check their connection after a failed
   *  cryptographic verification is the wrong advice. */
  | 'install-failed'

interface UpdaterState {
  status: UpdaterStatus
  update: UpdateInfo | null
  error: string | null
}

// ── Module singleton ──────────────────────────────────────────────────
// State outlives any single component: the startup check can resolve while
// the shell is still locked, and the modal picks it up when it mounts.
const IDLE: UpdaterState = { status: 'idle', update: null, error: null }

let snapshot: UpdaterState = IDLE
let startupChecked = false
const listeners = new Set<() => void>()

/** The one in-flight `check_for_update`, shared by every caller. Tracked apart
 *  from `snapshot.status`, which stays `'idle'` for a silent check and so
 *  cannot say whether a request is outstanding. */
let inFlight: Promise<UpdateInfo | null> | null = null

/** Bumped whenever the user takes over (dismiss, install). A check that
 *  resolves against a stale epoch publishes nothing: its answer is no longer
 *  what the user is looking at. */
let epoch = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): UpdaterState {
  return snapshot
}

function publish(next: UpdaterState): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Ask the backend whether a newer build exists on the user's channel.
 *
 * `silent` is what separates the startup check from the menu one: a silent
 * check never leaves `idle` unless it actually finds an update, so boot shows
 * no "checking…" flicker and no "you're up to date" nobody asked for.
 *
 * Only one request runs at a time. A user-initiated check *joins* an in-flight
 * silent one rather than skipping: it shows "checking…" and reports the shared
 * answer, so the menu item never looks dead. A silent check arriving second is
 * simply dropped — nobody is waiting on it.
 */
export async function checkForUpdates(options?: { silent?: boolean }): Promise<void> {
  const silent = options?.silent ?? false
  if (snapshot.status === 'checking' || snapshot.status === 'downloading') return
  if (silent && inFlight) return

  if (!silent) publish({ ...IDLE, status: 'checking' })

  const channel = useUiStore.getState().updateChannel
  const startedAt = epoch
  const request = (inFlight ??= invoke<UpdateInfo | null>('check_for_update', { channel }).finally(
    () => {
      inFlight = null
    },
  ))

  try {
    const info = await request
    // The user dismissed the modal or started an install while we waited (the
    // check can take up to 30s). Their action wins: never re-open a modal they
    // closed, never resurrect "Install" over a running download.
    if (epoch !== startedAt) return
    if (info) {
      publish({ status: 'available', update: info, error: null })
    } else if (!silent) {
      publish({ ...IDLE, status: 'up-to-date' })
    }
    // A silent no-update result publishes nothing: it must not clobber a
    // check the user started in the meantime.
  } catch (e) {
    // Always logged: a user-initiated check that fails after the modal was
    // closed would otherwise vanish without a trace.
    console.error('[updater] check_for_update failed', { channel, silent }, e)
    if (!silent && epoch === startedAt) {
      publish({ status: 'error', update: null, error: message(e) })
    }
  }
}

/**
 * Download, install and restart. The command does not return on success —
 * the app relaunches — so only the failure path publishes anything. There are
 * no progress events (the backend passes empty progress closures), hence the
 * indeterminate `downloading` status.
 */
export async function installUpdate(): Promise<void> {
  if (snapshot.status === 'downloading') return
  epoch += 1
  publish({ ...snapshot, status: 'downloading', error: null })
  // The restart kills the process from Rust, bypassing the window's
  // `CloseRequested` flush — WKWebView would drop the tab session on disk.
  flushTabSession()
  try {
    await invoke('install_update')
  } catch (e) {
    console.error('[updater] install_update failed', e)
    publish({ ...snapshot, status: 'install-failed', error: message(e) })
  }
}

/** "Later" — close the modal and drop the pending update from the UI. */
export function dismissUpdate(): void {
  epoch += 1
  publish(IDLE)
}

/**
 * One silent check per launch.
 *
 * The channel is read lazily by `checkForUpdates`, and `uiStore` uses
 * zustand's synchronous localStorage adapter without `skipHydration` — it is
 * already hydrated by the time anything calls this, so no explicit
 * `rehydrate()` (which would merge storage back over every persisted field).
 * Dev builds are a no-op — `check_for_update` returns `None` under
 * `debug_assertions`, so nothing reaches the network.
 */
export async function runStartupUpdateCheck(): Promise<void> {
  if (startupChecked) return
  // Opt-out (default on): this is the only unsolicited outbound request the
  // app makes, and it fires before the user unlocks. Nothing identifying is
  // sent, so what GitHub can learn is the user's IP and launch cadence — an
  // unrequested request all the same. `checkForUpdates` is deliberately not
  // gated, so `Memlore > Check For Updates…` keeps working when this is off.
  if (!useUiStore.getState().autoCheckUpdates) return
  startupChecked = true
  await checkForUpdates({ silent: true })
}

export function useUpdater() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(
    () => ({
      ...state,
      check: checkForUpdates,
      install: installUpdate,
      dismiss: dismissUpdate,
    }),
    [state],
  )
}

/** Test-only: reset module state between cases. */
export function __resetUpdaterForTests(): void {
  snapshot = IDLE
  startupChecked = false
  inFlight = null
  epoch = 0
  listeners.clear()
}
