import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { create } from 'zustand'
import { useForceRePairStore } from '../hooks/useForceRePair'
import {
  cloudFolderConnect,
  gdriveBeginConnect,
  gdriveCancelConnect,
  gdriveCompleteConnect,
  type CloudProviderKind,
  type GdriveConnectOutcome,
} from '../lib/tauri'
import { useSyncStore } from './syncStore'

// Tauri event + payload emitted by `gdrive_complete_connect` as it walks the
// slow post-callback Drive I/O phases. Keep the event name and the phase keys
// in sync with `GDRIVE_CONNECT_PROGRESS_EVENT` / `emit_connect_progress` in
// `src-tauri/src/commands/gdrive.rs`.
export const GDRIVE_CONNECT_PROGRESS_EVENT = 'gdrive:connect-progress'
export const CONNECT_PROGRESS_PHASES = [
  'exchanging_token',
  'establishing_root',
  'finalizing',
] as const
export type ConnectProgressPhase = (typeof CONNECT_PROGRESS_PHASES)[number]
interface ConnectProgressPayload {
  session_id: string
  phase: string
}

// Sentinel error string returned by `gdrive_complete_connect` when
// `gdrive_cancel_connect` notified the in-flight session. Mirrors
// `OAUTH_CANCELLED_MARKER` in the Tauri command — keep in sync with
// `src-tauri/src/commands/gdrive.rs`.
const OAUTH_CANCELLED_MARKER = 'OAUTH_CANCELLED'

// Namespaced i18n key for the generic connect failure, used both for outcomes
// that shouldn't reach the onboarding path (mode mismatch / re-pair) and for
// unrecognised errors. Namespaced so any component can render it via `t()`
// regardless of its own default namespace.
const GENERIC_ERROR_KEY = 'auth:onboarding.drive.error_generic'

export type GdriveConnectStatus = 'idle' | 'connecting' | 'success' | 'error'

/** Provider (and optional folder root) of the most recent `connect()` call. */
export type GdriveConnectTarget = {
  provider: CloudProviderKind
  rootPath?: string
}

interface GdriveConnectState {
  /** Lifecycle of the most recent (or in-flight) connect attempt. */
  status: GdriveConnectStatus
  /**
   * Provider chosen for the most recent `connect()`. Null before the first
   * attempt. Survives success/error so `GdriveConnectToaster` can interpolate
   * `{{provider}}` after DriveStep has unmounted.
   */
  target: GdriveConnectTarget | null
  /** Backend I/O phase, for the live hint under the button. Null when idle or
   *  before the first phase (user still in the browser). */
  phase: ConnectProgressPhase | null
  /** True between opening the OAuth URL and the callback resolving — drives the
   *  Cancel button. */
  isAwaitingCallback: boolean
  /** Namespaced i18n key describing the failure, for inline display. Null on
   *  success or while connecting. */
  errorKey: string | null
  /** Session id of the in-flight connect (needed to cancel + filter events). */
  sessionId: string | null
  /**
   * True once the terminal result has been surfaced to the user (the shell
   * toast). Lives in the store — NOT component-local — because the toaster
   * unmounts/remounts across lock/unlock (different App.tsx subtrees) while
   * `status` persists; a per-mount guard would re-toast on every unlock.
   * Reset when a fresh `connect()` begins so its result can toast anew.
   */
  resultAcknowledged: boolean
  /**
   * True while a Settings-initiated connect (GoogleDriveSettings.handleConnect)
   * is in flight. That flow owns its own local state and outcome handling, so it
   * does NOT drive `status` — doing so would make the onboarding toaster fire a
   * stale success/error notice. This flag is a footer-only signal so the global
   * SyncStatus can show "Connecting…" instead of the misleading "Sync off"
   * during a Settings connect too.
   */
  manualConnecting: boolean
  /**
   * Run the full connect flow. Lives in the store (not DriveStep) so the
   * awaited backend round-trips survive the wizard advancing past the Drive
   * step — the whole point of "connect in the background". Re-entrant calls
   * are ignored while a connect is already in flight.
   */
  connect: (password: string, target?: GdriveConnectTarget) => Promise<void>
  /** Cancel an in-flight OAuth wait, if any. */
  cancelAwaiting: () => Promise<void>
  /** Mark the terminal result as surfaced, so the toast fires at most once. */
  acknowledgeResult: () => void
  /**
   * Clear a terminal connect result (status / errorKey / phase) back to idle.
   * Settings folder-connect reads the inline result then calls this so the
   * onboarding toaster, CutoffReconnectStep, and FooterBar do not keep a
   * leftover success/error. Does not touch `manualConnecting`.
   */
  resetConnectResult: () => void
  /** Set/clear the Settings-initiated connect-in-flight footer signal. */
  setManualConnecting: (active: boolean) => void
}

const initialState = {
  status: 'idle' as GdriveConnectStatus,
  target: null as GdriveConnectTarget | null,
  phase: null,
  isAwaitingCallback: false,
  errorKey: null,
  sessionId: null,
  resultAcknowledged: false,
  manualConnecting: false,
}

/** Map a backend error message to a namespaced i18n key. */
function errorKeyForMessage(msg: string): string {
  if (msg.includes('timed out')) return 'settings:gdrive.errors.timed_out'
  if (msg.includes('KEYRING_MISMATCH') || msg.includes('Wrong password for cloud keyring'))
    return 'settings:gdrive.errors.keyring_mismatch'
  if (msg.includes('Cloud keyring is internally inconsistent'))
    return 'settings:gdrive.errors.keyring_corrupted'
  if (msg.includes('Invalid password')) return 'settings:gdrive.errors.invalid_password'
  if (msg.includes('Disconnect the current provider first'))
    return 'settings:cloud.errors.already_connected'
  if (msg.includes('Grant Memlore access')) return 'settings:cloud.errors.permission_denied'
  return GENERIC_ERROR_KEY
}

/**
 * Map an *error* terminal outcome to its inline error key. Only called for
 * outcomes other than `ready` and `needs_force_re_pair` (both handled in their
 * own branches in `connect`). `v1_wiped_reconnect_required` gets its specific
 * key; Unset-mode outcomes fall through to the generic key — matching the
 * original DriveStep behaviour.
 */
function errorKeyForOutcome(outcome: GdriveConnectOutcome): string {
  if (outcome.outcome === 'v1_wiped_reconnect_required')
    return 'settings:gdrive.errors.v1_wiped_reconnect'
  return GENERIC_ERROR_KEY
}

/**
 * Pure decision for the shell toaster: which result (if any) to surface now.
 * Extracted so the defer-behind-celebration + fire-once logic is unit-testable
 * without a component test. Returns the toast kind, or null to stay quiet.
 */
export function shouldSurfaceConnectResult(
  status: GdriveConnectStatus,
  resultAcknowledged: boolean,
  celebrationPending: boolean,
  manualConnecting = false,
): 'success' | 'error' | null {
  if (resultAcknowledged) return null
  // Settings folder-connect owns inline copy and sets `manualConnecting`.
  // Stay quiet so the onboarding Drive toaster does not fire for that path.
  if (manualConnecting) return null
  // Wait behind the one-shot onboarding celebration modal — see GdriveConnectToaster.
  if (celebrationPending) return null
  if (status === 'success') return 'success'
  if (status === 'error') return 'error'
  return null
}

export const useGdriveConnectStore = create<GdriveConnectState>((set, get) => ({
  ...initialState,

  connect: async (password, target = { provider: 'gdrive' }) => {
    if (get().status === 'connecting') return
    const folderProvider = target.provider === 'gdrive' ? null : target.provider
    set({
      status: 'connecting',
      target,
      phase: null,
      isAwaitingCallback: folderProvider === null,
      errorKey: null,
      sessionId: null,
      resultAcknowledged: false,
    })

    let unlisten: UnlistenFn | undefined
    try {
      const attachProgress = () =>
        listen<ConnectProgressPayload>(GDRIVE_CONNECT_PROGRESS_EVENT, (event) => {
          const { session_id, phase } = event.payload
          if (session_id !== get().sessionId) return
          if ((CONNECT_PROGRESS_PHASES as readonly string[]).includes(phase)) {
            set({ phase: phase as ConnectProgressPhase })
          }
        })

      let outcome: GdriveConnectOutcome
      if (folderProvider) {
        const sessionId = crypto.randomUUID()
        set({ sessionId })
        unlisten = await attachProgress()
        outcome = await cloudFolderConnect(
          sessionId,
          folderProvider,
          target.rootPath ?? null,
          password,
        )
      } else {
        const begin = await gdriveBeginConnect()
        set({ sessionId: begin.sessionId })
        unlisten = await attachProgress()
        await openUrl(begin.authUrl)
        // Never short-circuit this await: `gdrive_cancel_connect` resolves it via
        // the OAUTH_CANCELLED marker (handled in catch) or the outcome switch.
        outcome = await gdriveCompleteConnect(begin.sessionId, password)
        set({ isAwaitingCallback: false })
      }

      if (outcome.outcome === 'ready') {
        set({ status: 'success', phase: null, errorKey: null })
        // Flip the sync store's `enabled` promptly so the footer leaves the
        // "Connecting…" state even if the first sync below fails before it
        // refreshes — otherwise the `success && !enabled` footer guard could
        // linger. Fire-and-forget; `refresh` swallows its own errors.
        void useSyncStore.getState().refresh()
        // Fire-and-forget first sync so the new vault reaches the cloud.
        void useSyncStore
          .getState()
          .syncNow()
          .catch(() => {})
      } else if (outcome.outcome === 'needs_force_re_pair') {
        // The backend already persisted the blocking force-re-pair flags before
        // returning this. Hand off to the global force-re-pair flow (App renders
        // ForceRePairScreen, which preempts the wizard and main shell) — the same
        // imperative path GoogleDriveSettings uses. Step this store aside to a
        // NON-toasting idle state: the force-re-pair flag is the authoritative
        // state now, and leaving `status: 'error'` here would make the toaster
        // fire a stale failure notice after the user completes re-pair.
        useForceRePairStore.getState().setForceRePair(outcome.reason)
        set({ status: 'idle', phase: null, errorKey: null })
      } else {
        set({ status: 'error', phase: null, errorKey: errorKeyForOutcome(outcome) })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes(OAUTH_CANCELLED_MARKER)) {
        // User cancelled — back to a clean idle state, no error surfaced.
        set({ status: 'idle', phase: null, errorKey: null })
      } else {
        set({ status: 'error', phase: null, errorKey: errorKeyForMessage(msg) })
      }
    } finally {
      if (unlisten) unlisten()
      set({ isAwaitingCallback: false, sessionId: null })
    }
  },

  cancelAwaiting: async () => {
    const sessionId = get().sessionId
    if (!sessionId) return
    set({ isAwaitingCallback: false })
    try {
      await gdriveCancelConnect(sessionId)
    } catch (err) {
      console.warn('gdriveCancelConnect failed', err)
    }
  },

  acknowledgeResult: () => set({ resultAcknowledged: true }),

  resetConnectResult: () =>
    set({
      status: 'idle',
      phase: null,
      errorKey: null,
      sessionId: null,
      isAwaitingCallback: false,
      resultAcknowledged: true,
    }),

  setManualConnecting: (active) => set({ manualConnecting: active }),
}))

/** Test-only: reset the store between cases. */
export function __resetGdriveConnectStoreForTests() {
  useGdriveConnectStore.setState({ ...initialState })
}
