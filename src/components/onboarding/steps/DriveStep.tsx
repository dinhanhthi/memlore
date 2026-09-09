import { CheckCircle2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useIcloudAvailability } from '../../../hooks/useIcloudAvailability'
import { usePickFolder } from '../../../hooks/usePickFolder'
import { isMacOS } from '../../../lib/platform'
import {
  asCloudProviderKind,
  defaultSelectedProvider,
  pickerIcloudAvailable,
  providerLabel,
  settlePickerSelection,
} from '../../../lib/providerLabel'
import type { CloudProviderKind, GDriveStatus } from '../../../lib/tauri'
import { gdriveGetStatus } from '../../../lib/tauri'
import { useGdriveConnectStore } from '../../../stores/gdriveConnectStore'
import { Button } from '../../common/Button'
import { CloudProviderPicker } from '../../settings/CloudProviderPicker'

interface DriveStepProps {
  /** Reports whether a cloud provider is connected so the wizard shell can hide
   *  "Skip for now" once connecting is no longer relevant. */
  onConnectedChange?: (connected: boolean) => void
  /** Reports whether a connect is in flight so the wizard shell can hide
   *  "Skip for now" while connecting — skipping mid-connect would be a trap. */
  onBusyChange?: (busy: boolean) => void
}

/**
 * `DriveStep` — connect a cloud provider from inside the onboarding wizard.
 *
 * Mirrors `GoogleDriveSettings` disconnect-state connect: this is the
 * existing-local-vault → empty-cloud case, which expects outcome `ready`.
 * This is NOT the adopt-existing-cloud path in `WelcomeScreen` — that one
 * pulls a foreign vault down and is semantically the opposite. Connecting is
 * optional here; the wizard shell shows its own "Skip for now" button until
 * this step reports connected, so this component never blocks advancing.
 *
 * The connect flow itself lives in `useGdriveConnectStore`, not here, so the
 * slow post-OAuth / folder I/O keeps running when the user advances past this
 * step ("connect in the background"). This component only drives the UI and
 * reads status from that store; the final result is surfaced by
 * `GdriveConnectToaster` in the main shell once the user has moved on.
 */
export function DriveStep({ onConnectedChange, onBusyChange }: DriveStepProps = {}) {
  const { t } = useTranslation(['auth', 'settings'])
  const { t: tSettings } = useTranslation('settings')

  const connectStatus = useGdriveConnectStore((s) => s.status)
  const phase = useGdriveConnectStore((s) => s.phase)
  const isAwaitingCallback = useGdriveConnectStore((s) => s.isAwaitingCallback)
  const errorKey = useGdriveConnectStore((s) => s.errorKey)
  const storeTarget = useGdriveConnectStore((s) => s.target)

  const { available: icloudAvailable, loading: icloudLoading } = useIcloudAvailability()
  const pickFolder = usePickFolder()

  const [probeStatus, setProbeStatus] = useState<GDriveStatus | null>(null)
  const [isCheckingStatus, setIsCheckingStatus] = useState(true)
  const [selected, setSelected] = useState<CloudProviderKind>(() =>
    defaultSelectedProvider(isMacOS(), pickerIcloudAvailable(isMacOS(), false, true)),
  )
  const userTouchedProvider = useRef(false)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [folderError, setFolderError] = useState(false)

  const isBusy = connectStatus === 'connecting'
  // Success is anchored on the store (survives remount), independent of the
  // best-effort `gdriveGetStatus()` probe — a transient probe failure must not
  // un-confirm a connection that already succeeded and re-offer the button.
  const isConnected = probeStatus?.connected === true || connectStatus === 'success'
  const attemptKind = storeTarget?.provider ?? selected
  const badgeKind = asCloudProviderKind(probeStatus?.provider) ?? attemptKind
  const i18nProvider = {
    provider: providerLabel(isConnected ? badgeKind : selected, tSettings),
  }
  const errorProvider = { provider: providerLabel(attemptKind, tSettings) }
  const pickerIcloud = pickerIcloudAvailable(isMacOS(), icloudAvailable, icloudLoading)
  const displayError = folderError
    ? tSettings('cloud.errors.folder_required')
    : errorKey
      ? t(errorKey, errorProvider)
      : null

  useEffect(() => {
    if (icloudLoading) return
    setSelected((current) =>
      settlePickerSelection(current, userTouchedProvider.current, isMacOS(), icloudAvailable),
    )
  }, [icloudLoading, icloudAvailable])

  // Keep the wizard shell's Skip button in sync with connection state
  // (including resume when status is already connected on mount). Wait
  // for the status probe so a remount after connect does not briefly
  // report `false` and flash Skip while `gdriveGetStatus` is in flight.
  useEffect(() => {
    if (isCheckingStatus && connectStatus !== 'success') return
    onConnectedChange?.(isConnected)
  }, [isConnected, isCheckingStatus, connectStatus, onConnectedChange])

  // Report connect-in-flight so the shell can hide "Skip for now" while a
  // connect is running — advancing past a connect the user just started would
  // be surprising, and the flow is designed to finish in the background.
  useEffect(() => {
    onBusyChange?.(isBusy)
  }, [isBusy, onBusyChange])

  // While DriveStep is mounted it shows the terminal result inline (the
  // "Connected" badge or the inline error), so claim it — otherwise the
  // main-shell toaster would re-announce the same result once the user
  // finishes onboarding. If DriveStep unmounts while still `connecting`, this
  // never runs and the toaster fires once later (the true background case).
  useEffect(() => {
    if (connectStatus === 'success' || connectStatus === 'error') {
      useGdriveConnectStore.getState().acknowledgeResult()
    }
  }, [connectStatus])

  // Task 6.2 — idempotency on resume: a user who connected, quit, and
  // relaunched must see "Connected" immediately, not be prompted to connect
  // again. Guard against React StrictMode's double-mount the same way
  // `WelcomeScreen`'s mount probe does (a `cancelled` flag set in
  // the effect cleanup). The Connect button stays disabled while this probe
  // is in flight (see `isCheckingStatus` below), so there is no window for a
  // fast connect to race this probe and get torn down.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await gdriveGetStatus()
        if (cancelled) return
        setProbeStatus(s)
      } catch {
        // Best-effort — leave status null, the Connect button renders.
      } finally {
        if (!cancelled) setIsCheckingStatus(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handlePickFolder = async () => {
    const path = await pickFolder()
    if (path) {
      setLocalPath(path)
      setFolderError(false)
    }
  }

  const handleConnect = () => {
    if (selected === 'local' && !localPath) {
      setFolderError(true)
      return
    }
    setFolderError(false)
    // No password re-entry: the vault was unlocked moments ago during
    // first-time setup, so the in-memory master is the ownership proof and the
    // backend accepts an empty password here (see `password_check_required` in
    // gdrive.rs). Hand the flow to the store (which owns the OAuth session +
    // progress listener) so it outlives this step.
    void useGdriveConnectStore.getState().connect('', {
      provider: selected,
      rootPath: selected === 'local' ? (localPath ?? undefined) : undefined,
    })
  }

  if (isConnected) {
    return (
      <div className="flex flex-col items-center gap-2">
        <span className="bg-success/15 text-success-text inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium">
          <CheckCircle2 className="size-4" aria-hidden />
          {t('onboarding.drive.connected', i18nProvider)}
        </span>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {displayError && (
        <p role="alert" className="text-danger-text text-xs">
          {displayError}
        </p>
      )}

      <CloudProviderPicker
        value={selected}
        onChange={(kind) => {
          userTouchedProvider.current = true
          setSelected(kind)
          setFolderError(false)
        }}
        localPath={localPath}
        onPickFolder={() => {
          void handlePickFolder()
        }}
        icloudAvailable={pickerIcloud}
        disabled={isBusy}
      />
      <p className="text-fg-muted text-center text-xs">{t('onboarding.drive.picker_hint')}</p>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          disabled={isBusy || isCheckingStatus}
          loading={isBusy}
          onClick={handleConnect}
        >
          {isBusy
            ? t('onboarding.drive.connecting', i18nProvider)
            : t('onboarding.drive.connect_button', i18nProvider)}
        </Button>
        {selected === 'gdrive' && isAwaitingCallback && (
          <Button
            variant="ghost"
            size="md"
            onClick={() => void useGdriveConnectStore.getState().cancelAwaiting()}
          >
            {t('onboarding.drive.cancel')}
          </Button>
        )}
      </div>

      {isBusy && (
        <div className="flex flex-col items-center gap-0.5 text-center">
          {phase && (
            <p aria-live="polite" className="text-fg-muted text-xs">
              {t(`onboarding.drive.progress.${phase}`)}
            </p>
          )}
          <p className="text-fg-muted text-xs">{t('onboarding.drive.background_hint')}</p>
        </div>
      )}
    </div>
  )
}
