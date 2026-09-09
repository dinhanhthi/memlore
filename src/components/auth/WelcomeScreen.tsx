import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, CloudDownload } from 'lucide-react'
import { FirstTimeSetupWizard } from './FirstTimeSetupWizard'
import { OnboardNewDeviceScreen } from './OnboardNewDeviceScreen'
import { LanguageStep } from '../onboarding/steps/LanguageStep'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { SlideOverPanel } from '../common/SlideOverPanel'
import { CloudProviderPicker } from '../settings/CloudProviderPicker'
import { useIcloudAvailability } from '../../hooks/useIcloudAvailability'
import { usePickFolder } from '../../hooks/usePickFolder'
import { useOnboardingStore } from '../../stores/onboardingStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSyncStore } from '../../stores/syncStore'
import {
  CONNECT_PROGRESS_PHASES,
  GDRIVE_CONNECT_PROGRESS_EVENT,
  type ConnectProgressPhase,
} from '../../stores/gdriveConnectStore'
import { useForceRePairStore } from '../../hooks/useForceRePair'
import {
  planExistingCloudConnect,
  shouldShowExistingCloudCancel,
} from '../../lib/existingCloudConnect'
import { isMacOS } from '../../lib/platform'
import {
  defaultSelectedProvider,
  pickerIcloudAvailable,
  providerLabel,
  settlePickerSelection,
} from '../../lib/providerLabel'
import {
  cloudFolderConnect,
  gdriveBeginConnect,
  gdriveCancelConnect,
  gdriveCompleteConnect,
  gdriveDisconnect,
  gdriveGetStatus,
  type CloudProviderKind,
  type GdriveConnectOutcome,
} from '../../lib/tauri'
import { AuthPageCard } from '../common/AuthPageCard'
import { cn } from '../../lib/cn'

export type Screen =
  | 'language'
  | 'intro'
  | 'setup-wizard'
  | 'onboard-existing'
  | 'cloud-empty-prompt'

// Sentinel returned by `gdrive_complete_connect` when the user cancels mid-flow.
// Mirrors `OAUTH_CANCELLED_MARKER` in GoogleDriveSettings.
const OAUTH_CANCELLED_MARKER = 'OAUTH_CANCELLED'

// Backend guard sentinels — surfaced as typed strings by begin_first_time_setup,
// confirm_first_time_setup, onboard_complete. Frontend pattern-matches the
// prefix to render a clear UX message instead of the raw error string.
const UNSAFE_SETUP_MARKER = 'UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED'
const CLOUD_VAULT_EXISTS_MARKER = 'CLOUD_VAULT_EXISTS_USE_ONBOARDING'
const PENDING_DRIVE_SESSION_EXPIRED_MARKER = 'PENDING_DRIVE_SESSION_EXPIRED'

interface Props {
  onSetupSuccess?: () => void
  /** Screen to open on first mount (defaults to `language`). Only used by the
   *  web preview harness to deep-link straight to a given screen — the real
   *  app always enters at `language`. */
  initialScreen?: Screen
}

/**
 * `WelcomeScreen` — the first-run root, shown while `encryption_mode` is
 * `unset`.
 *
 * Memlore is **always encrypted**: there is no mode choice. The screen order is
 *
 *   language → intro → FirstTimeSetupWizard (→ done)
 *
 * with one side entrance for a device joining an existing vault:
 *
 *   intro → "Connect existing vault" (Drive OAuth)
 *         → onboard-existing   (cloud already holds a vault)
 *         → cloud-empty-prompt (Drive connected, cloud empty → first-time setup)
 *
 * The join surface above is reworked by Phase 6 task 4 (phrase typed or
 * QR-imported); task 1 only removed the mode choice from it.
 */
export function WelcomeScreen({ onSetupSuccess, initialScreen = 'language' }: Props) {
  const { t } = useTranslation('auth')
  const { t: tSettings } = useTranslation('settings')

  // Language selection is the very first thing shown on a fresh install, so the
  // intro (and every later step) renders in the user's language. It's
  // localStorage-only, so it works before any vault exists.
  const [screen, setScreen] = useState<Screen>(initialScreen)
  const [explainerOpen, setExplainerOpen] = useState(false)

  // Drive-connect state (the "I already have a journal" entrance)
  const [cloudConnectBusy, setCloudConnectBusy] = useState(false)
  const [isAwaitingCallback, setIsAwaitingCallback] = useState(false)
  const [cloudConnectError, setCloudConnectError] = useState('')
  // Backend I/O phase of the in-flight connect, for the live hint under the
  // link. Mirrors DriveStep so the heavy post-OAuth Drive work (token exchange
  // → root folder → keyring probe) shows progress instead of a frozen UI.
  const [cloudConnectPhase, setCloudConnectPhase] = useState<ConnectProgressPhase | null>(null)
  const pendingSessionIdRef = useRef<string | null>(null)
  // Captured Drive OAuth session_id for the needs_onboarding path. Passed to
  // OnboardNewDeviceScreen so the backend can consume the pending session and
  // persist sync settings atomically with the password flip.
  const [onboardSessionId, setOnboardSessionId] = useState<string | null>(null)
  // Frozen at connect time so onboard copy names the vault that was just
  // joined, not a later picker snap (e.g. iCloud probe settling to Drive).
  const [onboardProviderKind, setOnboardProviderKind] = useState<CloudProviderKind | null>(null)
  // True until the mount-time hydration probe (see below) finishes. While true,
  // both entrances are disabled — this prevents a race where the probe is
  // in-flight, the user starts a connect mid-probe, OAuth completes very
  // quickly, the probe resolves, and the probe then tears down the
  // legitimately-just-paired Drive connection.
  const [hydrating, setHydrating] = useState(true)
  // Mirrors `cloudConnectBusy` for the mount-effect IIFE: the effect closure
  // captures `cloudConnectBusy` at mount (always `false`), so we cannot
  // re-read state directly from there. A ref lets the probe check the LIVE
  // busy state at the moment its `gdriveGetStatus` await resolves.
  const cloudConnectBusyRef = useRef(false)

  const setEncryptionMode = useSettingsStore((s) => s.setEncryptionMode)

  const { available: icloudAvailable, loading: icloudLoading } = useIcloudAvailability()
  const pickFolder = usePickFolder()
  const [selected, setSelected] = useState<CloudProviderKind>(() =>
    defaultSelectedProvider(isMacOS(), pickerIcloudAvailable(isMacOS(), false, true)),
  )
  const userTouchedProvider = useRef(false)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const pickerIcloud = pickerIcloudAvailable(isMacOS(), icloudAvailable, icloudLoading)
  const i18nProvider = { provider: providerLabel(selected, tSettings) }

  // Maps a backend typed-error string to a user-facing message. Returns null if
  // the input does not match any known sentinel — callers fall back to the
  // generic error renderer.
  const mapTypedError = (raw: string): string | null => {
    if (raw.includes(UNSAFE_SETUP_MARKER))
      return t('welcome_first_run.existing_cloud_error_unsafe_setup', i18nProvider)
    if (raw.includes(CLOUD_VAULT_EXISTS_MARKER))
      return t('welcome_first_run.existing_cloud_error_cloud_vault_exists', i18nProvider)
    if (raw.includes(PENDING_DRIVE_SESSION_EXPIRED_MARKER))
      return t('welcome_first_run.existing_cloud_error_pending_session_expired')
    return null
  }

  useEffect(() => {
    if (icloudLoading) return
    setSelected((current) =>
      settlePickerSelection(current, userTouchedProvider.current, isMacOS(), icloudAvailable),
    )
  }, [icloudLoading, icloudAvailable])

  // Trigger that opened the explainer panel — focus is restored here on close
  // (handled inside <SlideOverPanel>).
  const explainerTriggerRef = useRef<HTMLButtonElement>(null)

  // I5: The crash-recovery probe (getPendingFirstTimeSetup) is handled inside
  // useFirstTimeSetup (used by FirstTimeSetupWizard) on mount. Having a second
  // probe here created a race and a duplicate backend round-trip. Removed.

  // CRITICAL data-safety: hydrate Drive-connected state on mount. After a
  // successful `gdrive_complete_connect` that returned `needs_onboarding` or
  // `needs_first_time_setup`, the backend has persisted `sync_provider=gdrive`
  // + `sync_connected=true` BUT `encryption_mode` is still Unset (the user had
  // not yet entered their recovery phrase or finished setup). If the user
  // quits / restarts at this point, the next launch lands here with Drive
  // still wired up to a foreign vault. A subsequent first-time setup would
  // then publish bad data INTO that existing vault. Detect and disconnect to
  // restore a clean first-run state.
  //
  // Mount-only effect: we don't depend on any reactive value here — this runs
  // once when the welcome screen mounts.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const status = await gdriveGetStatus()
        if (cancelled) return
        // CRITICAL race guard: only disconnect if the user hasn't started a
        // legitimate connect attempt while we were probing. Otherwise a fast
        // OAuth completion overlapping a slow status probe would cause the
        // probe's `connected===true` observation to be of the *just-paired*
        // state — and we'd tear down the very connection the user is about to
        // onboard against.
        if (cloudConnectBusyRef.current || pendingSessionIdRef.current !== null) return
        if (status.connected) {
          // Re-check the cancelled flag right before the side-effect call.
          // React StrictMode double-invokes effects in dev; the prior run's
          // cleanup may have fired between the await above and this point.
          if (cancelled) return
          // Drive was left connected by an abandoned cloud-onboarding flow.
          // Force-disconnect so first-run starts from a clean slate.
          await gdriveDisconnect().catch(() => {})
        }
      } catch {
        // Best-effort — if status probe fails, leave state alone.
      } finally {
        if (!cancelled) setHydrating(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Effect intentionally has no deps: it runs exactly once per mount to probe
    // and scrub stale state. cloudConnectBusy / pendingSessionIdRef are read
    // inside the IIFE at resolution time, not captured at mount.
  }, [])

  // Disconnects Drive if it was left connected by an abandoned cloud-onboarding
  // flow. Used whenever the user backs out of the OnboardNewDeviceScreen or the
  // cloud-empty-prompt — both paths leave Drive connected with no local
  // encryption mode, which is the exact state that risks contaminating an
  // existing cloud vault on the next setup attempt.
  const abandonCloudOnboarding = async () => {
    try {
      await gdriveDisconnect()
    } catch {
      // Non-fatal; the user can still restart. Worst case the next
      // gdrive_complete_connect attempt finds stale state and the backend's own
      // reconcile cleans it up.
    }
    setOnboardSessionId(null)
    setOnboardProviderKind(null)
    setScreen('intro')
  }

  // "Set up a new journal" — launch the always-encrypted setup wizard.
  // Defensive disconnect: if the user started the connect-existing-vault flow
  // and got back to the intro by any path that didn't fire
  // abandonCloudOnboarding (e.g. window resize re-mount), Drive could still be
  // persisted as connected with an Unset local mode. The wizard would then
  // upload a fresh keyring INTO a foreign cloud vault. Disconnect first, then
  // enter the wizard.
  const handleStartSetup = async () => {
    setCloudConnectError('')
    setOnboardSessionId(null)
    setOnboardProviderKind(null)
    try {
      const status = await gdriveGetStatus()
      if (status.connected) {
        await gdriveDisconnect().catch(() => {})
      }
    } catch {
      // Best-effort.
    }
    setScreen('setup-wizard')
  }

  // Called by FirstTimeSetupWizard when the full flow completes
  const handleWizardComplete = () => {
    // encryptionMode has already been flipped by the wizard's useEffect
    setOnboardSessionId(null)
    setOnboardProviderKind(null)
    // Brand-new local vault just finished setup — show the post-setup
    // onboarding wizard on the next render.
    useOnboardingStore.getState().setPending()
    onSetupSuccess?.()
  }

  // ── Join: existing cloud vault ───────────────────────────────────────────
  // Pattern mirrors `GoogleDriveSettings.handleConnect`, but the local mode
  // here is `Unset`, so the backend skips password verification entirely.
  // We pass an empty password to `gdriveCompleteConnect`.

  const clearCloudConnectHooks = () => {
    pendingSessionIdRef.current = null
    setIsAwaitingCallback(false)
  }

  const handlePickExistingCloud = async (
    provider: CloudProviderKind,
    rootPath: string | null | undefined,
  ) => {
    setCloudConnectError('')
    const plan = planExistingCloudConnect(provider, rootPath)
    if (plan.kind === 'folder_required') {
      setCloudConnectError(tSettings('cloud.errors.folder_required'))
      return
    }
    if (cloudConnectBusy) return
    cloudConnectBusyRef.current = true
    setCloudConnectBusy(true)
    setCloudConnectPhase(null)
    let unlistenProgress: UnlistenFn | undefined
    const attachProgress = (sessionId: string) =>
      listen<{ session_id: string; phase: string }>(GDRIVE_CONNECT_PROGRESS_EVENT, (event) => {
        if (event.payload.session_id !== sessionId) return
        if ((CONNECT_PROGRESS_PHASES as readonly string[]).includes(event.payload.phase)) {
          setCloudConnectPhase(event.payload.phase as ConnectProgressPhase)
        }
      })
    try {
      let sessionId: string
      let outcome: GdriveConnectOutcome
      if (plan.kind === 'gdrive') {
        const begin = await gdriveBeginConnect()
        sessionId = begin.sessionId
        pendingSessionIdRef.current = sessionId
        setIsAwaitingCallback(true)
        // Progress listener — mirrors DriveStep/gdriveConnectStore. The slow work
        // runs in `gdrive_complete_connect` *after* the user returns from Google;
        // without this the screen just sits on "Connecting…". Only our own
        // session's phase events update the hint.
        unlistenProgress = await attachProgress(sessionId)
        await openUrl(begin.authUrl)
        // Unset-mode → backend bypasses password check; pass empty string.
        outcome = await gdriveCompleteConnect(sessionId, '')
      } else {
        sessionId = crypto.randomUUID()
        pendingSessionIdRef.current = sessionId
        setIsAwaitingCallback(false)
        unlistenProgress = await attachProgress(sessionId)
        outcome = await cloudFolderConnect(sessionId, plan.provider, plan.rootPath, '')
      }
      clearCloudConnectHooks()

      switch (outcome.outcome) {
        case 'needs_onboarding':
          // Cloud already has a vault. Show OnboardNewDeviceScreen so the user
          // can supply the recovery phrase + a new local password. Capture the
          // session_id BEFORE clearCloudConnectHooks nulls the ref, then store
          // it so OnboardNewDeviceScreen can forward it to the backend.
          setOnboardSessionId(sessionId)
          setOnboardProviderKind(provider)
          setScreen('onboard-existing')
          break
        case 'needs_first_time_setup':
          // Drive is connected but cloud is empty. Surface an inline notice
          // explaining that this is a first-time setup, with a CTA into the
          // setup wizard. Capture session_id so FirstTimeSetupWizard can
          // forward it to the backend when the user starts.
          setOnboardSessionId(sessionId)
          setOnboardProviderKind(provider)
          setScreen('cloud-empty-prompt')
          break
        case 'v1_wiped_reconnect_required':
          setCloudConnectError(t('welcome_first_run.existing_cloud_error_v1_wiped'))
          break
        case 'ready':
          // Unexpected from an Unset-mode local — defensively show an error.
          setCloudConnectError(t('welcome_first_run.existing_cloud_error_unexpected_ready'))
          break
        case 'needs_force_re_pair':
          // Route via the same store GoogleDriveSettings uses so App.tsx renders
          // ForceRePairScreen (replaces the whole UI). Should be rare from an
          // Unset local — possible if a peer device just rotated master_key
          // while this OAuth flow was in flight — but delegating to the
          // canonical surface gives the user a real recovery path instead of a
          // dead-end error string.
          useForceRePairStore.getState().setForceRePair(outcome.reason)
          break
        default:
          setCloudConnectError(
            t('welcome_first_run.existing_cloud_error_generic', {
              message: 'unknown_outcome',
              ...i18nProvider,
            }),
          )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes(OAUTH_CANCELLED_MARKER)) {
        // User cancelled — silent return to the intro.
        clearCloudConnectHooks()
      } else {
        // Map known backend sentinels to user-friendly copy; fall back to the
        // generic error message for unrecognised strings.
        const mapped = mapTypedError(msg)
        setCloudConnectError(
          mapped ??
            t('welcome_first_run.existing_cloud_error_generic', { message: msg, ...i18nProvider }),
        )
      }
    } finally {
      if (unlistenProgress) unlistenProgress()
      clearCloudConnectHooks()
      cloudConnectBusyRef.current = false
      setCloudConnectBusy(false)
      setCloudConnectPhase(null)
    }
  }

  // Cancel button handler. IMPORTANT — race contract (mirrors
  // `GoogleDriveSettings.handleCancelConnect`):
  //
  // The backend `gdrive_cancel_connect` command notifies the in-flight
  // `gdrive_complete_connect`, which then returns the `OAUTH_CANCELLED`
  // marker. We deliberately do NOT short-circuit the awaited
  // `gdriveCompleteConnect` here — `cancel_connect` may return `true`
  // (notifier fired) or `false` (the session was already consumed by a
  // successful complete). Either way the connect-in-flight promise resolves
  // shortly:
  //   - if cancel won  → handlePickExistingCloud's catch branch matches
  //     OAUTH_CANCELLED_MARKER and silently returns to the intro.
  //   - if complete won → outcome-switch in handlePickExistingCloud runs
  //     normally; the user briefly sees the intro flash before being routed
  //     onward. This UI flash is acceptable; "fixing" it by also clearing
  //     cloudConnectBusy here would leave the backend in a connected state
  //     while the UI shows disconnected.
  // Setting `isAwaitingCallback=false` immediately is only a hint to hide the
  // Cancel button — it doesn't affect the backend handshake.
  const handleCancelCloudConnect = async () => {
    const sessionId = pendingSessionIdRef.current
    if (!sessionId) return
    setIsAwaitingCallback(false)
    try {
      await gdriveCancelConnect(sessionId)
    } catch (err) {
      // Non-fatal; the awaiting promise will still resolve with OAUTH_CANCELLED.
      console.warn('gdriveCancelConnect failed', err)
    }
  }

  // Called by OnboardNewDeviceScreen once `tauri.onboardComplete` finishes
  // successfully. The backend has rekeyed the local DB and flipped
  // `encryption_mode = password`. We mirror that in the store so App.tsx routes
  // past onboarding on the next render. We `await` the gdrive status refresh
  // (rather than fire-and-forget) so that when the next mount of
  // `GoogleDriveSettings` happens, its initial `gdriveGetStatus()` returns the
  // cached connected snapshot instead of briefly rendering disconnected.
  // Mirrors `GoogleDriveSettings.handleConnect`'s post-`ready` refresh.
  const handleOnboardExistingSuccess = async () => {
    setOnboardSessionId(null)
    setOnboardProviderKind(null)
    // Arm the one-shot welcome modal BEFORE the encryption-mode flip, which
    // re-routes App.tsx to the main shell and unmounts this screen. The store
    // is a module-level singleton so the flag survives that unmount; being
    // persisted additionally carries it across an app restart, so a user who
    // quits before dismissing still gets told the sync is running.
    useOnboardingStore.getState().armJoinCelebration()
    setEncryptionMode('password')
    await gdriveGetStatus().catch(() => null)
    // Kick off the first sync immediately. Mirrors the `'ready'` branch in
    // GoogleDriveSettings.handleConnect. This one is fire-and-forget because a
    // full sync cycle can take seconds; we don't block onboarding completion
    // on it.
    void useSyncStore
      .getState()
      .syncNow()
      .catch(() => {})
    onSetupSuccess?.()
  }

  // ── Render: setup wizard ─────────────────────────────────────────────────
  // CRITICAL safety: when the wizard was reached via connect-existing-vault →
  // cloud-empty-prompt → "Set up a new journal", Drive is already connected and
  // `onboardSessionId` is populated. If the user cancels the wizard, we MUST
  // disconnect Drive AND clear `onboardSessionId` — otherwise the still-valid
  // pending session would leak into a later setup attempt against a foreign
  // vault. `abandonCloudOnboarding` does both. For the direct path,
  // `onboardSessionId` is already null and Drive is already disconnected by
  // handleStartSetup's defensive probe, so the same helper is a safe no-op.
  if (screen === 'setup-wizard') {
    return (
      <FirstTimeSetupWizard
        onSetupComplete={handleWizardComplete}
        onCancel={() => {
          void abandonCloudOnboarding()
        }}
        sessionId={onboardSessionId ?? undefined}
      />
    )
  }

  // ── Render: onboarding into an existing cloud vault ──────────────────────
  // CRITICAL safety: Drive is connected (token persisted, sync_connected=true)
  // but encryption_mode is still Unset until OnboardNewDeviceScreen completes.
  // If the user backs out without finishing, abandonCloudOnboarding disconnects
  // Drive so first-run starts from a clean slate — otherwise a subsequent
  // first-time setup could publish data into the foreign cloud vault.
  if (screen === 'onboard-existing') {
    return (
      <AuthPageCard className="max-w-130 p-8">
        <OnboardNewDeviceScreen
          onCompleted={handleOnboardExistingSuccess}
          onCancel={() => {
            void abandonCloudOnboarding()
          }}
          sessionId={onboardSessionId ?? undefined}
          providerKind={onboardProviderKind}
        />
      </AuthPageCard>
    )
  }

  // ── Render: cloud connected but empty → offer first-time setup ───────────
  // Same CRITICAL safety as above: Drive is connected with Unset local mode.
  // "Back" must disconnect Drive before returning to the intro. The "Set up a
  // new journal" CTA stays connected because FirstTimeSetupWizard is the
  // legitimate continuation of this flow — the wizard will upload the first
  // keyring as part of normal first-time setup.
  if (screen === 'cloud-empty-prompt') {
    return (
      <AuthPageCard className="flex max-w-120 flex-col gap-5 p-8 text-center">
        <div className="bg-accent-soft mx-auto flex items-center justify-center rounded-full p-3">
          <CloudDownload className="text-accent size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-fg text-xl font-bold">
          {t('welcome_first_run.cloud_empty_title', i18nProvider)}
        </h2>
        <p className="text-fg-muted text-sm leading-relaxed">
          {t('welcome_first_run.cloud_empty_body', i18nProvider)}
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            variant="ghost"
            onClick={() => {
              void abandonCloudOnboarding()
            }}
          >
            {t('welcome_first_run.existing_cloud_back')}
          </Button>
          <Button variant="primary" onClick={() => setScreen('setup-wizard')}>
            {t('welcome_first_run.cloud_empty_cta')}
          </Button>
        </div>
      </AuthPageCard>
    )
  }

  // ── Render: language selection (first screen on a fresh install) ─────────
  // Shown before the intro so every later onboarding step renders in the
  // language the user picks here. Purely localStorage-backed, so it needs no
  // vault.
  if (screen === 'language') {
    return (
      <AuthPageCard className="max-w-105 p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img
            src="/logo-without-container/logo-straight-256.png"
            width={100}
            height={100}
            className="block shrink-0"
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <h1 className="font-title text-fg text-2xl font-extrabold">
            {t('onboarding.language.welcome_title')}
          </h1>
          <p className="text-fg-muted text-sm">{t('onboarding.language.welcome_subtitle')}</p>
        </div>
        <div className="mb-8">
          <LanguageStep />
        </div>
        <div className="flex justify-end">
          <Button variant="primary" size="md" onClick={() => setScreen('intro')}>
            {t('onboarding.next')}
          </Button>
        </div>
      </AuthPageCard>
    )
  }

  // ── Render: intro ────────────────────────────────────────────────────────

  // Disable the join entrance while the mount-time hydration probe is in flight
  // — without this gate the probe could race a user-initiated connect and
  // silently tear it down (see the mount useEffect comment for the full race
  // trace). The same gate keeps the primary CTA from forking into two
  // onboarding paths while a connect is running.
  const actionsDisabled = cloudConnectBusy || hydrating

  // While the join-existing-vault flow runs, the primary CTA doubles as its
  // progress indicator (it's the biggest thing on the screen, and the flow
  // leaves the app for the browser). Two states, discriminated by
  // `cloudConnectPhase`: the backend only starts emitting connect-progress
  // phases from `gdrive_complete_connect` — i.e. AFTER the user approves the
  // Google account — so a null phase means we're still waiting on the browser.
  const ctaLabel = !cloudConnectBusy
    ? t('welcome_first_run.start_cta')
    : cloudConnectPhase == null
      ? t('welcome_first_run.cta_connecting')
      : t('welcome_first_run.cta_setting_up')

  return (
    <AuthPageCard data-testid="welcome-first-run" className="max-w-180 p-8">
      <div className="flex flex-col gap-8">
        {/* Header */}
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src="/stickers/sticker-privacy.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            className="block h-24 w-auto shrink-0"
          />
          <h1 className="font-title text-fg text-3xl font-extrabold">
            {t('welcome_first_run.title')}
          </h1>
          <p className="text-fg-muted text-sm">
            {t('welcome_first_run.subtitle')}{' '}
            <button
              ref={explainerTriggerRef}
              type="button"
              onClick={() => setExplainerOpen(true)}
              className={cn(
                'text-accent inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline',
                'rounded-sm',
              )}
            >
              {t('welcome.how_it_works.link')}
              <ArrowRight className="size-3.5 shrink-0" strokeWidth={1.75} />
            </button>
          </p>
        </div>

        {/* Primary path — set up a brand-new encrypted journal */}
        <Button
          variant="primary"
          size="lg"
          className="w-fit self-center"
          data-testid="start-first-time-setup"
          disabled={actionsDisabled}
          loading={cloudConnectBusy}
          onClick={() => {
            void handleStartSetup()
          }}
        >
          {ctaLabel}
        </Button>

        {/* Secondary path — this device is joining a vault that already exists
            in the cloud. Reworked by Phase 6 task 4. */}
        <div className="flex flex-col items-center gap-3">
          <p className="text-fg-muted text-center text-sm">
            {t('welcome_first_run.existing_cloud_title')}
          </p>
          <CloudProviderPicker
            value={selected}
            onChange={(kind) => {
              userTouchedProvider.current = true
              setSelected(kind)
              setCloudConnectError('')
            }}
            localPath={localPath}
            onPickFolder={() => {
              void (async () => {
                const path = await pickFolder()
                if (path) {
                  setLocalPath(path)
                  setCloudConnectError('')
                }
              })()
            }}
            icloudAvailable={pickerIcloud}
            disabled={actionsDisabled}
          />
          <p className="text-fg-muted text-center text-xs">{t('onboarding.drive.picker_hint')}</p>
          <p className="text-fg-muted flex flex-wrap items-center justify-center gap-x-2 text-center text-sm">
            <button
              type="button"
              onClick={() => {
                void handlePickExistingCloud(selected, selected === 'local' ? localPath : undefined)
              }}
              disabled={actionsDisabled}
              data-testid="existing-cloud-connect"
              className={cn(
                'text-accent font-medium underline-offset-2 hover:underline',
                'rounded-sm',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {/* Connecting copy is only true until a backend phase arrives.
                  Once a connect phase is live the CTA above carries the
                  progress narration — so we drop back to the static label. */}
              {cloudConnectBusy && cloudConnectPhase == null
                ? t('welcome_first_run.existing_cloud_connecting', i18nProvider)
                : t('welcome_first_run.existing_cloud_button')}
            </button>
            {shouldShowExistingCloudCancel(selected, isAwaitingCallback) && (
              <button
                type="button"
                onClick={handleCancelCloudConnect}
                data-testid="existing-cloud-cancel"
                className={cn(
                  'text-fg-muted font-medium underline-offset-2 hover:underline',
                  'rounded-sm',
                )}
              >
                {t('welcome_first_run.existing_cloud_cancel')}
              </button>
            )}
          </p>
        </div>

        {/* Live progress hint while the backend walks the slow post-OAuth Drive
            I/O — so the user knows work is happening instead of feeling frozen. */}
        {cloudConnectBusy && cloudConnectPhase && (
          <p aria-live="polite" className="text-fg-muted -mt-4 text-center text-xs">
            {t(`onboarding.drive.progress.${cloudConnectPhase}`)}
          </p>
        )}

        {/* Inline error for the cloud-connect path. */}
        {cloudConnectError && <Callout tone="danger">{cloudConnectError}</Callout>}
      </div>

      {/* Encryption explainer — slide-in side panel */}
      <SlideOverPanel
        open={explainerOpen}
        onClose={() => setExplainerOpen(false)}
        title={t('welcome.how_it_works.title')}
        closeLabel={t('welcome.how_it_works.close')}
        triggerRef={explainerTriggerRef}
      >
        <div className="flex flex-col gap-2">
          <p className="text-fg-muted text-sm leading-relaxed">
            {t('welcome.how_it_works.encryption.intro')}
          </p>
          <ul className="text-fg-muted flex flex-col gap-1.5 text-sm leading-relaxed">
            {[
              t('welcome.how_it_works.encryption.bullet1'),
              t('welcome.how_it_works.encryption.bullet2'),
              t('welcome.how_it_works.encryption.bullet3'),
              t('welcome.how_it_works.encryption.bullet4'),
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="text-accent mt-0.5 shrink-0 font-bold" aria-hidden="true">
                  ·
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </SlideOverPanel>
    </AuthPageCard>
  )
}
