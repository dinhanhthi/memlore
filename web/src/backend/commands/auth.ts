/**
 * Auth / unlock / onboard command map (Phase 9, task 9.1). Documentation only:
 * task 9.5 fills this file with the handlers. All paths are repo-root relative.
 * Line numbers were read at commit 900ab1b; re-check before relying on them.
 *
 * OWNER OF LOCK STATE
 *   There is no authStore. `src/hooks/useAuth.ts` owns unlock/lock/reconcile and
 *   writes `isLocked` + `encryptionMode` into `src/stores/settingsStore.ts`
 *   (`isLocked` defaults to false, settingsStore.ts:25). `src/lib/lock.ts:32` is
 *   the pure lockApp(); the screens never call `invoke` directly.
 *   The desktop "unlock" command is NOT named unlock: it is `initialize_encryption`.
 *
 * ARGS are camelCase exactly as the TS wrapper passes them; Tauri maps them to the
 * snake_case Rust params. Rust errors reach TS as plain strings (`typeof err ===
 * "string"`), so reject with a string-ish Error and keep sentinel text verbatim.
 *
 * ---------------------------------------------------------------------------
 * BOOT SEQUENCE (which result picks which screen)
 *   src/hooks/useAuth.ts:64-67 fires, in parallel, once on mount:
 *     get_startup_mode, get_encryption_mode, is_encryption_initialized
 *   then (useAuth.ts:99-103) is_biometric_available and, only if true,
 *   is_biometric_unlock_enabled. Any rejection => isLocked=true (useAuth.ts:88-91).
 *   Routing, src/App.tsx:
 *     !hasReconciled                          -> blank drag region     (App.tsx:330)
 *     startup === "boot_file_corrupt"         -> BootFileCorruptScreen (App.tsx:337)
 *     encryption_mode === "unset"             -> WelcomeScreen         (App.tsx:351)
 *        (useAuth.ts:54 needsOnboarding = reconciled && mode === "unset")
 *     force-re-pair flag set                  -> ForceRePair/Reconnect (App.tsx:372)
 *     mode === "password" && isLocked         -> LockScreen            (App.tsx:393)
 *     else                                    -> main UI
 *   isLocked is set true only when mode === "password" && !is_encryption_initialized
 *   (useAuth.ts:79-83). So WELCOME vs LOCK is decided by get_encryption_mode, NOT by
 *   get_startup_mode (startup_mode only matters for "boot_file_corrupt").
 *   After the real DB is "ready" (mode !== "password" || !isLocked, App.tsx:125) the
 *   shell also fires get_force_re_pair_status (hooks/useForceRePair.ts:4) and
 *   get_pending_rotation_recovery (App.tsx:211): both already default to null.
 *
 * get_startup_mode
 *   TS     src/lib/tauri.ts:785 StartupMode = "first_launch" | "password_locked" |
 *          "boot_file_corrupt"; wrapper tauri.ts:807 getStartupMode(), no args.
 *   Rust   src-tauri/src/commands/crypto.rs:68 -> crate::StartupMode (lib.rs:190,
 *          serde snake_case).
 *   Use    useAuth.ts:65,74 (only "boot_file_corrupt" is acted on).
 *   Web    "password_locked" when the IndexedDB `device` record exists, else
 *          "first_launch". (Plan 9.5 says "unset otherwise": "unset" is the
 *          get_encryption_mode value below, not a StartupMode value.)
 *
 * get_encryption_mode
 *   TS     tauri.ts:779 EncryptionMode = "unset" | "password"; wrapper tauri.ts:792.
 *   Rust   crypto.rs:52 -> serde lowercase string.
 *   Use    useAuth.ts:66,72,79 and every Welcome-vs-Lock decision above.
 *   Web    "password" when a `device` record exists, "unset" otherwise. REQUIRED:
 *          the current QUERY_DEFAULTS value is a constant "password", which would
 *          send a first-time browser to LockScreen instead of Welcome. 9.5 must move
 *          this command out of QUERY_DEFAULTS (unsupported.ts:101) into the handlers.
 *
 * is_encryption_initialized  (= "is the key loaded", i.e. unlocked)
 *   TS     tauri.ts:826 isEncryptionInitialized(): Promise<boolean>, no args.
 *   Rust   crypto.rs:1286 -> key_state.is_initialized().
 *   Use    useAuth.ts:67,80. After a page reload this MUST be false (key RAM is gone).
 *   Web    true iff the in-RAM KeyRing handle is held (keys.ts, task 9.3).
 *
 * UNLOCK = initialize_encryption
 *   TS     tauri.ts:810 initializeEncryption(password): Promise<void>
 *          args { password: string }.
 *   Rust   crypto.rs:1005 initialize_encryption(app, password: String) -> Result<(), String>.
 *   Use    useAuth.ts:128 inside unlock() (125-137); caller LockScreen.tsx:40.
 *          On success the hook does setLocked(false) (useAuth.ts:129); nothing else
 *          is read from the result.
 *   Errors Rust: "Invalid password" (crypto.rs:1053, AES-GCM tag failure on unwrap);
 *          "Encryption not initialized ..." (crypto.rs:1040) when nothing is stored.
 *          useAuth.ts:132 forwards the message, but LockScreen.tsx:41-43 IGNORES it and
 *          renders t("lock.invalid_password") for ANY rejection, so any thrown error
 *          shows the same wrong-password text. Use "Invalid password".
 *   Event  desktop emits "app:unlocked" with payload () (crypto.rs:1106). No src/ file
 *          listens to it (git grep over src/ finds none); only Rust workers do
 *          (lib.rs:1294). Web may emit it for parity; nothing in the web UI needs it.
 *   Web    unwrap the `device` wrapped master with the Argon2id KEK (core WASM), hold
 *          the KeyRing, reject "Invalid password" on failure. Replaces the
 *          ACTION_UNSUPPORTED entry "initialize_encryption" (unsupported.ts:435).
 *
 * LOCK = lock_encryption
 *   TS     tauri.ts:823 lockEncryption(): Promise<void>, no args.
 *   Rust   crypto.rs:1270 lock_encryption(app, key_state) -> Result<(), String>;
 *          clears the key, emits "app:locked" with payload () (crypto.rs:1275).
 *   Use    lock.ts:34 (lockApp; then clears chat drafts and setLocked(true),
 *          lock.ts:41-60), and useAuth.ts:149 on window "beforeunload" (best effort,
 *          result ignored). The UI flips isLocked itself; nothing needs the event.
 *   Event  "app:locked", payload () (listeners are Rust-only: lib.rs:1277).
 *   Web    KeyRing.lock() + drop handle + emit "app:locked"; must be idempotent and
 *          must never reject (lock.ts:35-40 only warns). Replaces unsupported.ts:436.
 *   Other lock-ish events the web UI DOES listen to: "xj://force-re-pair"
 *          (useForceRePair.ts:74) and "xj://rotation-resume-required"
 *          (useRotationResume.ts:69). Not part of this phase.
 *
 * get_device_id  (boot-time, syncStore)
 *   TS     tauri.ts:1598 getDeviceId(): Promise<string>; used by syncStore.ts:505.
 *   Rust   src-tauri/src/commands/sync.rs:354 (db::get_or_create_device_id).
 *   Web    `device.deviceId` when present, else keep "web-unavailable"
 *          (unsupported.ts:108). Must satisfy is_safe_device_id (task 9.4).
 *
 * ---------------------------------------------------------------------------
 * gdrive_begin_connect
 *   TS     tauri.ts:1233 BeginConnectResponse { authUrl: string; sessionId: string };
 *          wrapper tauri.ts:1246 gdriveBeginConnect(), no args.
 *   Rust   src-tauri/src/commands/gdrive.rs:469 -> BeginConnectResponse (gdrive.rs:148,
 *          serde camelCase: auth_url -> authUrl, session_id -> sessionId).
 *   Use    WelcomeScreen.tsx:307 (then openUrl(authUrl) at :316, which the web shim
 *          web/src/tauri/plugin-opener.ts serves), gdriveConnectStore.ts:209.
 *   Web    start the PKCE/OAuth flow from phase 8 (drive/oauth.ts) and return
 *          { authUrl, sessionId }. Replaces unsupported.ts:448.
 *
 * gdrive_complete_connect
 *   TS     tauri.ts:1258 gdriveCompleteConnect(sessionId, password) ->
 *          args { sessionId: string, password: string }.
 *          tauri.ts:1239 GdriveConnectOutcome =
 *            { outcome: "ready" } | { outcome: "needs_first_time_setup" } |
 *            { outcome: "needs_onboarding" } |
 *            { outcome: "needs_force_re_pair"; reason: string; cloud_epoch: number } |
 *            { outcome: "v1_wiped_reconnect_required" }
 *   Rust   gdrive.rs:583 -> GdriveConnectOutcome (gdrive.rs:124-146, serde tag
 *          "outcome", snake_case). Unset mode: resolve_unset_outcome_and_stash
 *          (gdrive.rs:1326-1346): keyring present -> needs_onboarding, absent ->
 *          needs_first_time_setup; the pending session is stashed under sessionId for
 *          the following onboard_* calls. password is "" in Unset mode (Welcome:318).
 *   Use    WelcomeScreen.tsx:318 and the outcome switch :328-370; gdriveConnectStore.ts:215
 *          (post-unlock Drive step, only "ready" and "needs_force_re_pair" matter).
 *   Events gdrive.rs:92 "gdrive:connect-progress", payload
 *          { session_id: string; phase: "exchanging_token" | "establishing_root" |
 *          "finalizing" } (snake_case keys); listened at WelcomeScreen.tsx:297 and
 *          gdriveConnectStore.ts:189 via the web event shim. Optional for the web.
 *   Errors cancel => message containing "OAUTH_CANCELLED" (gdrive.rs:701), matched by
 *          substring at WelcomeScreen.tsx:373 and gdriveConnectStore.ts:246 (silent
 *          return to the intro). Other sentinels mapped by WelcomeScreen.tsx:147-155
 *          (constants :56-64): UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED,
 *          CLOUD_VAULT_EXISTS_USE_ONBOARDING, PENDING_DRIVE_SESSION_EXPIRED; anything
 *          else renders t("welcome_first_run.existing_cloud_error_generic") =
 *          "Couldn't connect to {{provider}}: {{message}}" (locales/en/auth.json:142)
 *          with the raw message, and the screen stays on the intro.
 *   Web    keyring exists in the Drive folder -> { outcome: "needs_onboarding" }, and
 *          keep the Drive token in memory keyed by sessionId (the onboard_* calls pass
 *          it back). Keyring missing -> NO desktop-equivalent outcome exists for "the
 *          web cannot create a vault". Closest outcome is "needs_first_time_setup",
 *          but it renders the cloud-empty-prompt (WelcomeScreen.tsx:503: "Your
 *          {{provider}} is empty ... Create a new journal", CTA -> handleStartSetup ->
 *          setup-wizard -> begin_first_time_setup, which is unsupported on web), which
 *          is misleading. RECOMMENDED, needs NO src/ change: reject with a plain
 *          message such as "Create your vault in the Memlore desktop app first, then
 *          connect it here." It is shown through the generic path above
 *          ("Couldn't connect to Google Drive: <message>") and the user stays on the
 *          intro. A dedicated screen or copy would be a src/ change owned by Phase 12.
 *          Never return "ready" for an Unset device (WelcomeScreen.tsx:350 shows an
 *          "unexpected ready" error). Replaces unsupported.ts:450.
 *
 * gdrive_cancel_connect
 *   TS     tauri.ts:1256 gdriveCancelConnect(sessionId): Promise<boolean>,
 *          args { sessionId: string }.
 *   Rust   gdrive.rs:547 -> bool: true = cancel delivered to an in-flight session,
 *          false = already consumed/unknown (callers must then let connect finish,
 *          tauri.ts:1248-1255).
 *   Use    WelcomeScreen.tsx:418 (handler :413), gdriveConnectStore.ts:262.
 *          The in-flight gdrive_complete_connect must then reject with a message
 *          containing "OAUTH_CANCELLED" (race contract in WelcomeScreen.tsx:394-411).
 *   Web    abort the pending OAuth wait; return true if one was pending, else false.
 *          Replaces unsupported.ts:449.
 *
 * ---------------------------------------------------------------------------
 * onboard_validate_passphrase  (join step 1, stateless)
 *   TS     tauri.ts:1276 onboardValidatePassphrase(mnemonic, sessionId?): Promise<void>,
 *          args { mnemonic: string, sessionId?: string } (sessionId undefined when absent).
 *          The UI sends phrase.trim().toLowerCase().
 *   Rust   crypto.rs:2283 -> Result<(), String>; body onboard_validate_passphrase_inner
 *          crypto.rs:2389-2432 (peeks, does not consume, the pending session).
 *   Use    OnboardNewDeviceScreen.tsx:125 (and via useRecoveryQrImport.ts:44 for QR).
 *   Errors Plain strings shown verbatim (OnboardNewDeviceScreen.tsx:134-140): "Wrong
 *          recovery phrase. Check each word and try again." / "Could not verify the
 *          cloud vault - the recovery phrase may not match this vault." / "Cloud vault is
 *          missing the recovery slot - vault may be corrupted" / "Cloud vault _meta.json
 *          is missing" / invalid mnemonic text. (Rust writes an em dash where this
 *          comment writes a hyphen.) Missing session: OnboardNewDeviceScreen.tsx:129-133
 *          mentions a "Google Drive is not connected on this device" string, but that
 *          exact text was NOT found in src-tauri/src; the web may use any message.
 *   Web    run the validate half of the desktop protocol (recovery unwrap + fingerprint)
 *          with the in-memory Drive session; no state change. Replaces unsupported.ts:438.
 *
 * onboard_complete  (join step 2: rekey/store local KEK, device slot, unlock)
 *   TS     tauri.ts:1287 onboardComplete(mnemonic, newLocalPassword, deviceName,
 *          sessionId?, unlockMethod?): Promise<void>, args { mnemonic, newLocalPassword,
 *          deviceName, sessionId, unlockMethod: unlockMethod ?? null } where
 *          UnlockMethod = "password" | "os_kek" | "both" (tauri.ts:701; the UI sends
 *          "password" or "both"; "both" needs biometrics, which the web reports as
 *          unavailable, so expect "password").
 *   Rust   crypto.rs:2311 -> Result<(), String>; protocol onboard_complete_inner
 *          crypto.rs:2441 (content-key handling 2565-2674, device-slot upload ~3046).
 *   Use    OnboardNewDeviceScreen.tsx:173 then onCompleted() (:180).
 *          WelcomeScreen.handleOnboardExistingSuccess (:433-453) then does
 *          setEncryptionMode("password") and DOES NOT call setLocked, so the key must
 *          already be loaded when this resolves (desktop leaves the app unlocked; it
 *          emits "app:unlocked" via the same path as unlock). The screen also runs
 *          gdrive_get_status and sync_now afterwards (both tolerate defaults).
 *   Errors Plain strings shown verbatim (OnboardNewDeviceScreen.tsx:187-193):
 *          "Wrong recovery phrase. Check each word and try again.",
 *          "Recovery generation mismatch: control=<n>, keyring_meta=<n>",
 *          "An authoritative recovery is active on this cloud vault; retry after it
 *          finishes.", "Could not verify the cloud vault - ...".
 *   Web    follow the 10 ordered steps in the phase file (task 9.4), store the `device`
 *          record, leave the KeyRing loaded. Replaces unsupported.ts:437.
 *
 * ---------------------------------------------------------------------------
 * COMMANDS THAT STAY UNSUPPORTED (already in ACTION_UNSUPPORTED)
 *   begin_first_time_setup, confirm_first_time_setup, cancel_first_time_setup,
 *   change_password, verify_password, recover_with_passphrase, unlock_with_biometric,
 *   enable/disable_biometric_unlock, cloud_folder_connect. The web never creates a vault.
 *   Already harmless defaults: is_biometric_available/is_biometric_unlock_enabled
 *   (false), get_pending_first_time_setup (null), get_force_re_pair_status (null),
 *   get_pending_rotation_recovery (null), second_lock_status (false).
 *
 * ROUTER HOUSEKEEPING FOR 9.5
 *   Move get_startup_mode, get_encryption_mode, is_encryption_initialized,
 *   get_device_id out of QUERY_DEFAULTS, and initialize_encryption, lock_encryption,
 *   onboard_validate_passphrase, onboard_complete, gdrive_begin_connect,
 *   gdrive_complete_connect, gdrive_cancel_connect out of ACTION_UNSUPPORTED, because
 *   the coverage test requires a command to live in exactly one place.
 */

import type { Core } from '../../core/core'
import { emitFromBackend } from '../../tauri/event'
import {
  DriveAuthError,
  DriveReader,
  VaultNotReadyError,
  type DriveWriterDeps,
} from '../drive/client'
import {
  OAuthNetworkError,
  ReauthRequiredError,
  isSignInCancelled,
  oauth,
  type OAuthClient,
} from '../drive/oauth'
import { isUnlocked, lock, setKeyRing, type KeyRing } from '../keys'
import { openWebDb, type DeviceRecord, type WebDb } from '../storage/idb'
import type { OnboardDeps } from '../sync/onboard'
import type { Handler } from '../router'

// ---------------------------------------------------------------------------------------------
// Constants and messages
// ---------------------------------------------------------------------------------------------

const META_PATH = '.meta/keyring/_meta.json'
const RECOVERY_PATH = '.meta/keyring/_recovery.json'
const FALLBACK_ORIGIN = 'https://web.memlore.app'
const DEVICE_ID_PLACEHOLDER = 'web-unavailable'

/** Sentinels the UI matches on (WelcomeScreen.tsx:56-64, :373). */
const OAUTH_CANCELLED = 'OAUTH_CANCELLED'
const SESSION_EXPIRED = 'PENDING_DRIVE_SESSION_EXPIRED'

export const MSG_INVALID_PASSWORD = 'Invalid password'
export const MSG_NO_VAULT =
  'Create your vault in the Memlore desktop app first, then connect it here.'
const MSG_INCOMPLETE_KEYRING =
  'The cloud vault looks incomplete. Open the Memlore desktop app and check sync, then try again.'
const MSG_NOT_CONNECTED = 'Google Drive is not connected on this device. Connect it first.'
const MSG_LEASE = 'A recovery is in progress on another device. Try again later.'
const MSG_FORMAT =
  'This vault was created by a newer version of Memlore. Update the web app or use the desktop app.'
const MSG_NOT_READY = 'Open the Memlore desktop app once to finish setting up sync, then try again.'
const MSG_REAUTH = 'Google Drive session expired; reconnect required'
const MSG_NO_KEYS =
  'Could not load the vault keys. Connect to Google Drive (or go online) and try again.'
const MSG_DEVICE_CONFLICT =
  'This browser holds unsent edits for a different vault. Discard them (or reconnect that vault) before onboarding another.'
const MSG_NOT_INITIALIZED = 'Encryption not initialized on this device'

/** Wrong-password backoff: free tries, then 1 s, 2 s, 4 s ... capped at 30 s. */
export const FREE_TRIES = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/** A pending Drive connect session older than this is expired (PENDING_DRIVE_SESSION_EXPIRED). */
export const PENDING_SESSION_TTL_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// Injectable environment (defaults resolve lazily: importing this module has no side effects)
// ---------------------------------------------------------------------------------------------

export interface AuthEnv {
  now: () => number
  sleep: (ms: number) => Promise<void>
  emit: (event: string, payload?: unknown) => void
  randomUUID: () => string
  openDb: () => Promise<WebDb>
  loadCore: () => Promise<Core>
  oauth: Pick<OAuthClient, 'connect' | 'getAccessToken'>
  /** Drive transport. Default: bearer tokens from `oauth.getAccessToken`, real fetch. */
  driveDeps: (() => DriveWriterDeps) | null
  /** Extra `onboardComplete` deps (tests only). */
  onboardDeps: Partial<OnboardDeps>
  origin: () => string
}

let injected: Partial<AuthEnv> = {}
let dbPromise: Promise<WebDb> | null = null

function defaultEnv(): AuthEnv {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    emit: emitFromBackend,
    randomUUID: () => globalThis.crypto.randomUUID(),
    openDb: () =>
      openWebDb({
        onVersionChange: () => {
          dbPromise = null
        },
      }),
    loadCore: async () => (await import('../../core/core')).loadCore(),
    oauth,
    driveDeps: null,
    onboardDeps: {},
    origin: () => globalThis.location?.origin ?? FALLBACK_ORIGIN,
  }
}

const env = (): AuthEnv => ({ ...defaultEnv(), ...injected })

/** Test seam: override injected pieces. Pass `{}` to restore the defaults. */
export function configureAuthEnv(partial: Partial<AuthEnv>): void {
  injected = partial
  dbPromise = null
}

/** Tests only: forget pending connect sessions and the wrong-password backoff. */
export function resetAuthState(): void {
  for (const session of pending.values()) abandon(session)
  pending.clear()
  failures = 0
  blockedUntil = 0
  unlockQueue = Promise.resolve()
  dbPromise = null
}

function getDb(): Promise<WebDb> {
  dbPromise ??= env()
    .openDb()
    .catch((error: unknown) => {
      dbPromise = null
      throw error
    })
  return dbPromise
}

function driveDeps(): DriveWriterDeps {
  const e = env()
  return e.driveDeps ? e.driveDeps() : { getToken: () => e.oauth.getAccessToken(), sleep: e.sleep }
}

const onboardModule = () => import('../sync/onboard')

// ---------------------------------------------------------------------------------------------
// Wrong-password backoff (in memory: a reload resets it, the Argon2id cost is the real limit)
// ---------------------------------------------------------------------------------------------

let failures = 0
let blockedUntil = 0
/** Unlock attempts run one at a time, so N parallel wrong passwords count as N failures. */
let unlockQueue: Promise<void> = Promise.resolve()

function assertNotBlocked(now: number): void {
  if (now < blockedUntil) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil((blockedUntil - now) / 1000)} s.`)
  }
}

function recordFailure(now: number): void {
  failures += 1
  if (failures > FREE_TRIES) {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - FREE_TRIES - 1))
    blockedUntil = now + delay
  }
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

async function readDevice(): Promise<DeviceRecord | undefined> {
  return (await getDb()).device.get()
}

const getEncryptionMode: Handler = async () => ((await readDevice()) ? 'password' : 'unset')

// "boot_file_corrupt" is never produced on the web.
const getStartupMode: Handler = async () =>
  (await readDevice()) ? 'password_locked' : 'first_launch'

const getDeviceId: Handler = async () => (await readDevice())?.deviceId ?? DEVICE_ID_PLACEHOLDER

const isEncryptionInitialized: Handler = async () => isUnlocked()

// ---------------------------------------------------------------------------------------------
// Unlock / lock
// ---------------------------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

/**
 * Content keys for an unlock. The device record holds only the wrapped master, so the content list
 * comes from the Drive when a session exists, else from the cached copy. A Drive NotFound is NOT
 * enough to seed "master only": it also happens for another Google account, a reset vault folder
 * or an inconsistent listing, and the real content key is random. Master-only is used only when
 * `_meta.json` is readable, belongs to THIS device's vault (fingerprint) and pre-dates content keys
 * (`content_epoch` 0); otherwise the cached list answers, else the unlock fails closed. A cached
 * copy is never deleted here: it is replaced only by a successful read.
 */
async function loadContentKeys(
  ring: KeyRing,
  db: WebDb,
  core: Core,
  record: DeviceRecord,
): Promise<void> {
  const onboard = await onboardModule()
  const e = env()
  const v = onboard.readVersions(core)
  let text: string | null | undefined
  let driveError: unknown
  try {
    const reader = new DriveReader(driveDeps())
    text = await onboard.readContentFile(reader, e.sleep, { failFastOnTransport: true })
    if (text === null) {
      // Unknown until proven: any throw below must leave `text` undefined (cache, else fail closed).
      text = undefined
      if (await isPreContentKeyVault(onboard, reader, core, v, record)) {
        // Re-read once: a desktop may have run the epoch 0 -> 1 migration between the two reads, or
        // the `_meta.json` listing may be a stale epoch 0 snapshot. Master-only only if still absent.
        text = await onboard.readContentFile(reader, e.sleep, { failFastOnTransport: true })
      }
    }
    if (typeof text === 'string')
      await onboard.cacheContentText(db, text, e.now()).catch(() => undefined)
  } catch (error) {
    // No usable Drive session (signed out, offline) is not an error: the cache answers instead.
    const noSession =
      error instanceof ReauthRequiredError ||
      error instanceof OAuthNetworkError ||
      error instanceof DriveAuthError
    if (!noSession && !(error instanceof onboard.TransientReadError)) throw error
    driveError = noSession ? undefined : error
  }
  if (text === undefined) {
    const cached = await db.files.get(onboard.CONTENT_PATH)
    if (!cached) throw driveError ?? new Error(MSG_NO_KEYS)
    text = new TextDecoder().decode(cached.ciphertext)
  } else if (text === null) {
    // Never downgrade a ring that once had a content list: a cached list wins over master-only.
    const cached = await db.files.get(onboard.CONTENT_PATH)
    if (cached) text = new TextDecoder().decode(cached.ciphertext)
  }
  onboard.applyContentText(ring, text, v)
}

type OnboardModule = Awaited<ReturnType<typeof onboardModule>>

/** NotFound counts as "absent" only for this device's own, pre-content-key vault. */
async function isPreContentKeyVault(
  onboard: OnboardModule,
  reader: DriveReader,
  core: Core,
  v: ReturnType<OnboardModule['readVersions']>,
  record: DeviceRecord,
): Promise<boolean> {
  try {
    const meta = await onboard.readMeta(reader, core, v)
    return meta.masterFingerprint === record.masterFingerprint && meta.contentEpoch === 0
  } catch {
    return false
  }
}

const initializeEncryption: Handler = (args) => {
  const run = unlockQueue.then(() => unlockOnce(args))
  unlockQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const unlockOnce: Handler = async ({ password }) => {
  const e = env()
  assertNotBlocked(e.now())
  const db = await getDb()
  const record = await db.device.get()
  if (!record) throw new Error(MSG_NOT_INITIALIZED)
  if (typeof password !== 'string' || password === '') throw new Error(MSG_INVALID_PASSWORD)
  const core = await e.loadCore()
  let ring: KeyRing
  try {
    ring = core.KeyRing.unlockLocal(
      record.wrappedMasterHex,
      password,
      hexToBytes(record.kekSaltHex),
    )
  } catch {
    recordFailure(e.now())
    throw new Error(MSG_INVALID_PASSWORD)
  }
  try {
    await loadContentKeys(ring, db, core, record)
  } catch (error) {
    ring.lock()
    throw await mapOnboardError(error)
  }
  failures = 0
  blockedUntil = 0
  setKeyRing(ring)
  e.emit('app:unlocked')
}

const lockEncryption: Handler = async () => {
  lock('manual')
}

// ---------------------------------------------------------------------------------------------
// Drive connect (popup OAuth) and the pending session
// ---------------------------------------------------------------------------------------------

interface PendingSession {
  /** "connecting": popup open (cancellable). "inspecting": token held, keyring being checked. "ready". */
  phase: 'connecting' | 'inspecting' | 'ready'
  connect: Promise<void>
  cancelled: Promise<never>
  cancel: () => void
  reader: DriveReader | null
  createdAt: number
}

const pending = new Map<string, PendingSession>()

function abandon(session: PendingSession): void {
  if (session.phase === 'connecting') session.cancel()
  session.reader = null // a ready session's Drive reader is dropped too
}

const isExpired = (session: PendingSession): boolean =>
  env().now() - session.createdAt > PENDING_SESSION_TTL_MS

const gdriveBeginConnect: Handler = async () => {
  const e = env()
  for (const old of pending.values()) abandon(old)
  pending.clear()
  const sessionId = e.randomUUID()
  let rejectCancelled!: (error: Error) => void
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject
  })
  cancelled.catch(() => undefined)
  const connect = e.oauth.connect()
  connect.catch(() => undefined) // surfaced through complete; never an unhandled rejection
  pending.set(sessionId, {
    phase: 'connecting',
    connect,
    cancelled,
    cancel: () => rejectCancelled(new Error(OAUTH_CANCELLED)),
    reader: null,
    createdAt: e.now(),
  })
  // The popup is already open (opened here, inside the click gesture). The UI still calls
  // openUrl(authUrl); the sign-in itself is the popup, so this is a state-free same-origin JSON URL.
  // TODO(later): see docs/LATER.md - Phase 12 should skip openUrl for this web flow.
  return { authUrl: `${e.origin()}/api/config`, sessionId }
}

async function keyringExists(reader: DriveReader): Promise<boolean> {
  const meta = await reader.resolvePath(META_PATH)
  const recovery = await reader.resolvePath(RECOVERY_PATH)
  if (meta === null && recovery === null) return false
  if (meta === null || recovery === null) throw new Error(MSG_INCOMPLETE_KEYRING)
  return true
}

const gdriveCompleteConnect: Handler = async ({ sessionId }) => {
  const id = String(sessionId)
  const session = pending.get(id)
  if (!session) throw new Error(SESSION_EXPIRED)
  if (isExpired(session)) {
    abandon(session)
    pending.delete(id)
    throw new Error(SESSION_EXPIRED)
  }
  try {
    try {
      await Promise.race([session.connect, session.cancelled])
    } catch (error) {
      if (isSignInCancelled(error)) {
        throw new Error(OAUTH_CANCELLED)
      }
      throw error
    }
    session.phase = 'inspecting'
    const reader = new DriveReader(driveDeps())
    if (!(await keyringExists(reader))) throw new Error(MSG_NO_VAULT)
    session.reader = reader
    session.phase = 'ready'
    return { outcome: 'needs_onboarding' }
  } catch (error) {
    pending.delete(id)
    throw error
  }
}

const gdriveCancelConnect: Handler = async ({ sessionId }) => {
  const session = pending.get(String(sessionId))
  if (!session || session.phase !== 'connecting') return false
  session.cancel()
  return true
}

// ---------------------------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------------------------

/** Plain English sentences for the typed onboard errors (the UI renders them verbatim). */
async function mapOnboardError(error: unknown): Promise<Error> {
  const o = await onboardModule()
  const message =
    error instanceof o.RecoveryInProgressError
      ? MSG_LEASE
      : error instanceof o.DeviceRecordConflictError
        ? MSG_DEVICE_CONFLICT
        : error instanceof o.FormatUnsupportedError
          ? MSG_FORMAT
          : error instanceof VaultNotReadyError
            ? MSG_NOT_READY
            : error instanceof ReauthRequiredError || error instanceof DriveAuthError
              ? MSG_REAUTH
              : null
  if (message !== null) return new Error(message, { cause: error })
  return error instanceof Error ? error : new Error(String(error))
}

function readySession(sessionId: unknown): { id: string; reader: DriveReader } {
  const id = String(sessionId)
  const session = pending.get(id)
  if (session && isExpired(session)) {
    abandon(session)
    pending.delete(id)
    throw new Error(SESSION_EXPIRED)
  }
  if (!session || session.phase !== 'ready' || !session.reader) {
    throw new Error(MSG_NOT_CONNECTED)
  }
  return { id, reader: session.reader }
}

// Peeks: the session stays for onboard_complete.
const onboardValidatePassphrase: Handler = async ({ mnemonic, sessionId }) => {
  const { reader } = readySession(sessionId)
  const { validatePassphrase } = await onboardModule()
  try {
    await validatePassphrase(reader, String(mnemonic), { core: await env().loadCore() })
  } catch (error) {
    throw await mapOnboardError(error)
  }
}

// Consumes the session on success AND failure (the UI reconnects after an error).
const onboardComplete: Handler = async ({ mnemonic, newLocalPassword, sessionId }) => {
  const { id, reader } = readySession(sessionId)
  const e = env()
  try {
    const { onboardComplete: run } = await onboardModule()
    await run(
      {
        reader,
        driveDeps: driveDeps(),
        db: await getDb(),
        core: await e.loadCore(),
        ...e.onboardDeps,
      },
      { phrase: String(mnemonic), password: String(newLocalPassword) },
    )
  } catch (error) {
    throw await mapOnboardError(error)
  } finally {
    pending.delete(id)
  }
  e.emit('app:unlocked')
}

export const authHandlers: Record<string, Handler> = {
  get_encryption_mode: getEncryptionMode,
  get_startup_mode: getStartupMode,
  get_device_id: getDeviceId,
  is_encryption_initialized: isEncryptionInitialized,
  initialize_encryption: initializeEncryption,
  lock_encryption: lockEncryption,
  gdrive_begin_connect: gdriveBeginConnect,
  gdrive_complete_connect: gdriveCompleteConnect,
  gdrive_cancel_connect: gdriveCancelConnect,
  onboard_validate_passphrase: onboardValidatePassphrase,
  onboard_complete: onboardComplete,
}
