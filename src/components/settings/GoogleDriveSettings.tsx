import { openUrl } from '@tauri-apps/plugin-opener'
import { Clock, Cloud, HardDrive, Mail, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useForceRePairStore } from '../../hooks/useForceRePair'
import { useIcloudAvailability } from '../../hooks/useIcloudAvailability'
import { usePickFolder } from '../../hooks/usePickFolder'
import { useScopeUpgradeBanner } from '../../hooks/useScopeUpgradeBanner'
import type { CloudProviderKind, GDriveStatus, GdriveConnectOutcome } from '../../lib/tauri'
import {
  gdriveBeginConnect,
  gdriveCancelConnect,
  gdriveCompleteConnect,
  gdriveDisconnect,
  gdriveGetStatus,
  gdriveRefreshStorageQuota,
} from '../../lib/tauri'
import { cn } from '../../lib/cn'
import { displayCloudRootPath } from '../../lib/displayCloudRootPath'
import { isMacOS } from '../../lib/platform'
import {
  asCloudProviderKind,
  defaultSelectedProvider,
  pickerIcloudAvailable,
  providerLabel,
  settlePickerSelection,
} from '../../lib/providerLabel'
import {
  RECOVERY_FAILURE_FALLBACK_KEY,
  recoveryFailureMessage,
  toRecoveryDirection,
  type RecoveryDirection,
} from '../../lib/recoveryBlockerMessage'
import { resumeRecoveryUntilSettled } from '../../lib/resumeRecoveryUntilSettled'
import { useGdriveConnectStore } from '../../stores/gdriveConnectStore'
import { useSyncRecoveryWizardStore } from '../../stores/syncRecoveryWizardStore'
import { useSyncStore } from '../../stores/syncStore'
import { useTabStore } from '../../stores/tabStore'
import { OnboardNewDeviceScreen } from '../auth/OnboardNewDeviceScreen'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { PasswordInput } from '../common/PasswordInput'
import { SyncStatus } from '../common/SyncStatus'
import { Tooltip } from '../common/Tooltip'
import { CloudProviderPicker } from './CloudProviderPicker'
import { SettingsSection } from './SettingsSection'
import { SyncRecoveryWizard } from './syncRecovery/SyncRecoveryWizard'

// Sentinel error string returned by the Tauri `gdrive_complete_connect`
// command when `gdrive_cancel_connect` notified the in-flight session.
// Matches the exact prefix used in `src-tauri/src/commands/gdrive.rs`.
const OAUTH_CANCELLED_MARKER = 'OAUTH_CANCELLED'
const GDRIVE_CRITICAL_QUOTA_NOTICE_DISMISSED_KEY = 'memlore:gdrive-critical-quota-notice-dismissed'

function isCriticalQuotaNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(GDRIVE_CRITICAL_QUOTA_NOTICE_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

type StorageUsageSeverity = 'normal' | 'warning' | 'critical'

/**
 * Account-wide Drive free-space summary.
 * `freePercentage` is remaining capacity (what the UI shows).
 * Severity still tracks how full the account is (used ratio).
 */
function getStorageUsage(
  used: number,
  total: number,
): {
  freeBytes: number
  freePercentage: number
  severity: StorageUsageSeverity
} {
  const freeBytes = Math.max(0, total - used)
  const usedRatio = total > 0 ? used / total : 0
  const freePercentage = total > 0 ? Math.round((freeBytes / total) * 100) : 0

  if (usedRatio > 0.95) return { freeBytes, freePercentage, severity: 'critical' }
  if (usedRatio >= 0.8) return { freeBytes, freePercentage, severity: 'warning' }
  return { freeBytes, freePercentage, severity: 'normal' }
}

function recoveryPhaseLabelKey(phase: string): string {
  switch (phase) {
    case 'created':
      return 'gdrive.help.recovery.phase_created'
    case 'preflight':
      return 'gdrive.help.recovery.phase_preflight'
    case 'backup':
      return 'gdrive.help.recovery.phase_backup'
    case 'fenced':
      return 'gdrive.help.recovery.phase_fenced'
    case 'transfer':
      return 'gdrive.help.recovery.phase_transfer'
    case 'verify':
      return 'gdrive.help.recovery.phase_verify'
    case 'commit':
      return 'gdrive.help.recovery.phase_commit'
    case 'finalize':
      return 'gdrive.help.recovery.phase_finalize'
    case 'fence_release_pending':
      return 'gdrive.help.recovery.phase_fence_release_pending'
    default:
      return 'gdrive.help.recovery.phase_unknown'
  }
}

function recoveryStatusLabelKey(status: string): string {
  if (status === 'failed') return 'gdrive.help.recovery.status_failed'
  if (status === 'running') return 'gdrive.help.recovery.status_running'
  if (status === 'pending') return 'gdrive.help.recovery.status_pending'
  return 'gdrive.help.recovery.status_running'
}

/**
 * `GoogleDriveSettings` — Cloud Service connection panel inside Sync Settings.
 *
 * Disconnected: provider picker + password + Connect. Connected: provider-
 * gated account/folder summary + SyncStatus (Sync now / Disconnect / Help).
 * Recovery progress stays visible on the panel while the wizard is closed.
 */
export function GoogleDriveSettings() {
  const { t } = useTranslation('settings')
  const { available: icloudAvailable, loading: icloudLoading } = useIcloudAvailability()
  const pickFolder = usePickFolder()
  const lastErrorAction = useSyncStore((s) => s.lastErrorAction)
  const lastError = useSyncStore((s) => s.lastError)
  const isSyncing = useSyncStore((s) => s.isSyncing)
  const recovery = useSyncStore((s) => s.recovery)
  const wizardReplaceConfirmOpen = useSyncRecoveryWizardStore(
    (s) =>
      s.open &&
      (s.state.step === 'cloud_to_local_confirm' || s.state.step === 'local_to_cloud_confirm'),
  )
  const resumeRecovery = useSyncStore((s) => s.resumeRecovery)
  const cancelRecovery = useSyncStore((s) => s.cancelRecovery)
  const refreshRecovery = useSyncStore((s) => s.refreshRecovery)
  const setSettingsCategory = (category: 'security' | 'media') =>
    useTabStore.getState().updateActiveTab({ settingsCategory: category })

  const [status, setStatus] = useState<GDriveStatus | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectSuccess, setConnectSuccess] = useState(false)
  const [password, setPassword] = useState('')
  const [selected, setSelected] = useState<CloudProviderKind>(() =>
    defaultSelectedProvider(isMacOS(), pickerIcloudAvailable(isMacOS(), false, true)),
  )
  const userTouchedProvider = useRef(false)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [criticalQuotaNoticeDismissed, setCriticalQuotaNoticeDismissed] = useState(
    isCriticalQuotaNoticeDismissed,
  )

  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false)
  const [recoveryActionBusy, setRecoveryActionBusy] = useState(false)
  const [recoveryBannerError, setRecoveryBannerError] = useState<string | null>(null)
  const [recoverySuccess, setRecoverySuccess] = useState<
    'local_to_cloud' | 'cloud_to_local' | null
  >(null)

  const [showOnboarding, setShowOnboarding] = useState(false)
  const { required: scopeUpgradeRequired, dismiss: dismissScopeUpgrade } = useScopeUpgradeBanner()
  const pendingSessionIdRef = useRef<string | null>(null)
  const [isAwaitingCallback, setIsAwaitingCallback] = useState(false)
  // Bumped on unmount / disconnect so a slow appDataFolder sum cannot
  // overwrite a newer status after the user left connected state.
  const storageRefreshGenRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // Cheap cached snapshot first so the panel paints immediately.
        const s = await gdriveGetStatus()
        if (cancelled) return
        setStatus(s)
        // Live account + Memlore appDataFolder usage — Drive only.
        if (s.connected && s.provider === 'gdrive') {
          const gen = ++storageRefreshGenRef.current
          const fresh = await gdriveRefreshStorageQuota().catch(() => null)
          if (!cancelled && gen === storageRefreshGenRef.current && fresh) {
            setStatus(fresh)
          }
        }
      } catch {
        if (!cancelled) setError(t('gdrive.errors.load_status'))
      } finally {
        if (!cancelled) setIsInitialLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      storageRefreshGenRef.current += 1
    }
  }, [t])

  useEffect(() => {
    if (icloudLoading) return
    setSelected((current) =>
      settlePickerSelection(current, userTouchedProvider.current, isMacOS(), icloudAvailable),
    )
  }, [icloudLoading, icloudAvailable])

  const isConnected = status?.connected === true
  const provider = asCloudProviderKind(status?.provider)
  const connectKind = provider ?? selected
  const i18nProvider = { provider: providerLabel(connectKind, t) }
  const recoveryActive = recovery?.isActive === true
  const recoveryBlocksActions = recoveryActive || recoveryActionBusy
  const recoveryConfirmOpen = recoveryActive && recovery && !wizardReplaceConfirmOpen
  // Resume only for retryable / no-error (backend canResume already gates;
  // keep a UI-side check so Terminal/PreflightBlocker never show Resume).
  const showRecoveryResume =
    !!recovery?.canResume && (recovery.errorClass === null || recovery.errorClass === 'retryable')
  // Recovery errors arrive as raw engineer-facing strings — translate them
  // into copy the user can act on.
  const translateRecoveryFailure = (raw: string, operation: string | null | undefined) => {
    const failure = recoveryFailureMessage(raw, toRecoveryDirection(operation))
    return t(failure.key, { ...failure.params, ...i18nProvider })
  }

  const clearCancelHooks = () => {
    pendingSessionIdRef.current = null
    setIsAwaitingCallback(false)
  }

  const handleCancelConnect = async () => {
    const sessionId = pendingSessionIdRef.current
    if (!sessionId) return
    setIsAwaitingCallback(false)
    try {
      await gdriveCancelConnect(sessionId)
    } catch (err) {
      console.warn('gdriveCancelConnect failed', err)
    }
  }

  const handleConnect = async () => {
    setError(null)
    setConnectSuccess(false)
    if (!password) {
      setError(t('gdrive.errors.password_required', i18nProvider))
      return
    }
    setIsBusy(true)
    // Footer-only signal so the global SyncStatus reads "Connecting…" instead of
    // "Sync off" during this Settings-initiated connect. Cleared in `finally`.
    useGdriveConnectStore.getState().setManualConnecting(true)
    try {
      const begin = await gdriveBeginConnect()
      pendingSessionIdRef.current = begin.sessionId
      setIsAwaitingCallback(true)
      await openUrl(begin.authUrl)
      const outcome: GdriveConnectOutcome = await gdriveCompleteConnect(begin.sessionId, password)
      clearCancelHooks()
      setPassword('')

      switch (outcome.outcome) {
        case 'ready': {
          const fresh = await gdriveGetStatus().catch(() => null)
          if (fresh) setStatus(fresh)
          setConnectSuccess(true)
          // Flip the sync store's `enabled` before `finally` clears the
          // connecting signal, so the footer transitions straight to the real
          // sync state without a "Sync off" flash.
          await useSyncStore.getState().refresh()
          void useSyncStore
            .getState()
            .syncNow()
            .catch(() => {})
          break
        }
        case 'needs_onboarding':
          setShowOnboarding(true)
          break
        case 'needs_first_time_setup':
          setConnectSuccess(true)
          break
        case 'v1_wiped_reconnect_required':
          setError(t('gdrive.errors.v1_wiped_reconnect'))
          break
        case 'needs_force_re_pair':
          useForceRePairStore.getState().setForceRePair(outcome.reason)
          break
        default:
          setConnectSuccess(true)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes(OAUTH_CANCELLED_MARKER)) {
        clearCancelHooks()
      } else if (msg.includes('timed out')) {
        setError(t('gdrive.errors.timed_out'))
      } else if (
        msg.includes('KEYRING_MISMATCH') ||
        msg.includes('Wrong password for cloud keyring')
      ) {
        setError(t('gdrive.errors.keyring_mismatch', i18nProvider))
      } else if (msg.includes('Cloud keyring is internally inconsistent')) {
        setError(t('gdrive.errors.keyring_corrupted', i18nProvider))
      } else if (msg.includes('Invalid password')) {
        setError(t('gdrive.errors.invalid_password'))
      } else {
        setError(t('gdrive.errors.connect_failed', { message: msg, ...i18nProvider }))
      }
    } finally {
      clearCancelHooks()
      setIsBusy(false)
      useGdriveConnectStore.getState().setManualConnecting(false)
    }
  }

  const handleFolderConnect = async (kind: CloudProviderKind) => {
    setError(null)
    setConnectSuccess(false)
    if (!password) {
      setError(t('gdrive.errors.password_required', i18nProvider))
      return
    }
    if (kind === 'local' && !localPath) {
      setError(t('cloud.errors.folder_required'))
      return
    }
    setIsBusy(true)
    useGdriveConnectStore.getState().setManualConnecting(true)
    try {
      await useGdriveConnectStore.getState().connect(password, {
        provider: kind,
        rootPath: kind === 'local' ? (localPath ?? undefined) : undefined,
      })
      const store = useGdriveConnectStore.getState()
      const fresh = await gdriveGetStatus().catch(() => null)
      if (fresh) setStatus(fresh)
      if (store.status === 'success' || fresh?.connected) {
        setPassword('')
        setConnectSuccess(true)
      } else if (store.status === 'error' && store.errorKey) {
        setError(t(store.errorKey, i18nProvider))
      }
    } finally {
      // Settings owns inline copy — clear terminal store state so the
      // onboarding toaster / CutoffReconnectStep / FooterBar stay isolated.
      useGdriveConnectStore.getState().resetConnectResult()
      setIsBusy(false)
      useGdriveConnectStore.getState().setManualConnecting(false)
    }
  }

  const handleConnectClick = () => {
    if (selected === 'gdrive') {
      void handleConnect()
      return
    }
    void handleFolderConnect(selected)
  }

  const handlePickFolder = async () => {
    const path = await pickFolder()
    if (path) setLocalPath(path)
  }

  const handleReconnect = async () => {
    setError(null)
    setConnectSuccess(false)
    setIsBusy(true)
    try {
      // Invalidate any in-flight storage refresh before tearing down the session.
      storageRefreshGenRef.current += 1
      await gdriveDisconnect()
      const newStatus = await gdriveGetStatus()
      setStatus(newStatus)
      await useSyncStore.getState().refresh()
      // Clear the stale token_revoked banner AFTER refresh so the footer
      // transitions directly from error → disabled, never flashing the
      // stale "4d ago" timestamp while status.enabled is still true.
      useSyncStore.setState({ lastErrorAction: null, lastError: null, lastErrorKey: null })
      setDisconnectConfirmOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsBusy(false)
    }
  }

  const runRecoveryToCompletion = async (
    direction: 'local_to_cloud' | 'cloud_to_local',
  ): Promise<void> => {
    setRecoveryActionBusy(true)
    setRecoveryBannerError(null)
    setRecoverySuccess(null)
    try {
      // Advance until the job is no longer active (each resume is one step).
      const next = await resumeRecoveryUntilSettled(
        useSyncStore.getState().recovery,
        resumeRecovery,
      )
      if (next?.isActive) {
        throw new Error(next.lastError ?? 'recovery did not complete')
      }
      setRecoverySuccess(direction)
      await useSyncStore.getState().refresh()
    } finally {
      setRecoveryActionBusy(false)
    }
  }

  const runRecoveryToCompletionFromWizard = async (direction: RecoveryDirection): Promise<void> => {
    try {
      await runRecoveryToCompletion(direction)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const failure = recoveryFailureMessage(msg, direction)
      const text = t(failure.key, { ...failure.params, ...i18nProvider })
      setRecoveryBannerError(
        failure.key === RECOVERY_FAILURE_FALLBACK_KEY
          ? t(
              direction === 'local_to_cloud'
                ? 'gdrive.help.local_to_cloud.error'
                : 'gdrive.help.cloud_to_local.error',
              { message: text, ...i18nProvider },
            )
          : text,
      )
      await refreshRecovery().catch(() => {})
    }
  }

  const reloadStatus = async () => {
    storageRefreshGenRef.current += 1
    const fresh = await gdriveGetStatus()
    setStatus(fresh)
  }

  const handleResumeRecovery = async () => {
    setRecoveryActionBusy(true)
    setRecoveryBannerError(null)
    try {
      const next = await resumeRecoveryUntilSettled(
        useSyncStore.getState().recovery,
        resumeRecovery,
      )
      if (next?.isActive && next.lastError) {
        setRecoveryBannerError(translateRecoveryFailure(next.lastError, next.operation))
      } else if (!next?.isActive) {
        const op = next?.operation
        if (op === 'local_to_cloud' || op === 'cloud_to_local') {
          setRecoverySuccess(op)
        } else {
          setRecoverySuccess('local_to_cloud')
        }
      }
      await useSyncStore.getState().refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRecoveryBannerError(
        translateRecoveryFailure(msg, useSyncStore.getState().recovery?.operation),
      )
      await refreshRecovery().catch(() => {})
    } finally {
      setRecoveryActionBusy(false)
    }
  }

  const handleCancelRecovery = async () => {
    setRecoveryActionBusy(true)
    setRecoveryBannerError(null)
    try {
      await cancelRecovery()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRecoveryBannerError(
        translateRecoveryFailure(msg, useSyncStore.getState().recovery?.operation),
      )
    } finally {
      setRecoveryActionBusy(false)
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 MB'
    if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  }

  const formatDate = (unixSec: number) =>
    new Date(unixSec * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  const connectDisabled = isBusy || isInitialLoading
  const pickerIcloud = pickerIcloudAvailable(isMacOS(), icloudAvailable, icloudLoading)
  const actionsDisabled = isBusy || recoveryBlocksActions

  const showOpenSyncHelp =
    isConnected &&
    !!lastError &&
    lastErrorAction?.kind !== 'gdrive_token_revoked' &&
    lastErrorAction?.kind !== 'cross_mode_needs_password' &&
    lastErrorAction?.kind !== 'cross_mode_needs_no_password' &&
    lastErrorAction?.kind !== 'force_re_pair_required'

  const storageUsage =
    status?.storageUsed != null && status.storageTotal != null
      ? getStorageUsage(status.storageUsed, status.storageTotal)
      : null
  const hasAppStorage = status?.storageAppUsed != null
  const showStorageBlock = hasAppStorage || storageUsage != null
  const showCriticalQuotaNotice =
    storageUsage?.severity === 'critical' && !criticalQuotaNoticeDismissed

  const dismissCriticalQuotaNotice = () => {
    try {
      localStorage.setItem(GDRIVE_CRITICAL_QUOTA_NOTICE_DISMISSED_KEY, 'true')
    } catch {
      // Keep the notice dismissed for this mounted panel if storage is unavailable.
    }
    setCriticalQuotaNoticeDismissed(true)
  }

  return (
    <SettingsSection
      title={isConnected && provider ? providerLabel(provider, t) : t('cloud.title')}
      hint={t('cloud.hint')}
      titleAccessory={
        isConnected ? (
          <span className="bg-success/15 text-success-text text-2xs inline-flex items-center rounded-full px-1.5 py-0.5 font-medium">
            {t('cloud.badge_connected')}
          </span>
        ) : undefined
      }
    >
      {provider === 'gdrive' && lastErrorAction?.kind === 'gdrive_token_revoked' && (
        <Callout
          tone="danger"
          className="mb-4"
          title={t('gdrive.token_revoked.title')}
          action={
            <Button
              variant="primary"
              size="xs"
              loading={isBusy}
              disabled={isBusy}
              onClick={handleReconnect}
              data-testid="gdrive-token-revoked-reconnect"
            >
              {isBusy ? t('gdrive.token_revoked.busy') : t('gdrive.token_revoked.cta')}
            </Button>
          }
        >
          {t('gdrive.token_revoked.body')}
        </Callout>
      )}

      {provider === 'gdrive' && lastErrorAction?.kind === 'cross_mode_needs_password' && (
        <Callout
          tone="danger"
          className="mb-4"
          title={t('gdrive.cross_mode.needs_password_title')}
          action={
            <Button
              variant="primary"
              size="xs"
              onClick={() => setSettingsCategory('security')}
              data-testid="cross-mode-goto-security"
            >
              {t('gdrive.cross_mode.cta')}
            </Button>
          }
        >
          <p>{t('gdrive.cross_mode.needs_password_body')}</p>
          <p className="mt-1">{t('gdrive.cross_mode.needs_password_note')}</p>
        </Callout>
      )}
      {provider === 'gdrive' && lastErrorAction?.kind === 'cross_mode_needs_no_password' && (
        <Callout
          tone="danger"
          className="mb-4"
          title={t('gdrive.cross_mode.needs_no_password_title')}
          action={
            <Button
              variant="primary"
              size="xs"
              onClick={() => setSettingsCategory('security')}
              data-testid="cross-mode-goto-security"
            >
              {t('gdrive.cross_mode.cta')}
            </Button>
          }
        >
          <p>{t('gdrive.cross_mode.needs_no_password_body')}</p>
          <p className="mt-1">{t('gdrive.cross_mode.needs_no_password_note')}</p>
        </Callout>
      )}

      {recoverySuccess && (
        <Callout
          tone="success"
          className="mb-4"
          action={
            <Button variant="ghost" size="xs" onClick={() => setRecoverySuccess(null)}>
              {t('gdrive.help.delete_and_disconnect.dismiss_success')}
            </Button>
          }
        >
          {recoverySuccess === 'local_to_cloud'
            ? t('gdrive.help.local_to_cloud.success', i18nProvider)
            : t('gdrive.help.cloud_to_local.success', i18nProvider)}
        </Callout>
      )}

      {provider === 'gdrive' && scopeUpgradeRequired && (
        <Callout
          tone="warning"
          className="mb-4"
          title={t('gdrive.scope_upgrade.title')}
          action={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void dismissScopeUpgrade()
              }}
            >
              {t('gdrive.scope_upgrade.dismiss')}
            </Button>
          }
        >
          <p>{t('gdrive.scope_upgrade.body')}</p>
          <p className="mt-1">{t('gdrive.scope_upgrade.note')}</p>
        </Callout>
      )}

      {/* Active / interrupted recovery stays on the panel. Hide while the
          wizard is on a replace-confirm step so preflight success does not
          stack Resume/Cancel beside Confirm. */}
      {recoveryConfirmOpen && (
        <div
          className="border-border-default bg-elevated mb-4 flex flex-col gap-2 rounded-lg border p-4 text-sm"
          role="status"
          data-testid="gdrive-recovery-progress"
        >
          <p className="text-fg font-medium">
            {recovery.status === 'failed'
              ? t('gdrive.help.recovery.interrupted_title')
              : t('gdrive.help.recovery.title')}
          </p>
          <p className="text-fg-secondary text-xs">
            {recovery.operation === 'cloud_to_local'
              ? t('gdrive.help.recovery.operation_cloud_to_local', i18nProvider)
              : t('gdrive.help.recovery.operation_local_to_cloud', i18nProvider)}
          </p>
          <p className="text-fg-muted text-xs">
            {t(recoveryPhaseLabelKey(recovery.phase), i18nProvider)}
            {' · '}
            {t(recoveryStatusLabelKey(recovery.status))}
          </p>
          {recovery.backupPath && (
            <p className="text-fg-muted text-xs break-all">
              {t('gdrive.help.recovery.backup_path', { path: recovery.backupPath })}
            </p>
          )}
          {(recovery.lastError || recoveryBannerError) && (
            <p className="text-danger-text text-xs" role="alert">
              {recoveryBannerError ??
                translateRecoveryFailure(recovery.lastError ?? '', recovery.operation)}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {showRecoveryResume && (
              <Button
                variant="secondary"
                size="xs"
                loading={recoveryActionBusy}
                disabled={recoveryActionBusy}
                onClick={() => {
                  void handleResumeRecovery()
                }}
                data-testid="gdrive-recovery-resume"
              >
                {recoveryActionBusy
                  ? t('gdrive.help.recovery.resuming')
                  : t('gdrive.help.recovery.resume')}
              </Button>
            )}
            {recovery.canCancelSafely && (
              <Button
                variant="ghost"
                size="xs"
                disabled={recoveryActionBusy}
                onClick={() => {
                  void handleCancelRecovery()
                }}
                data-testid="gdrive-recovery-cancel"
              >
                {recoveryActionBusy
                  ? t('gdrive.help.recovery.cancelling')
                  : t('gdrive.help.recovery.cancel')}
              </Button>
            )}
          </div>
        </div>
      )}

      {!recoveryActive && recoveryBannerError && (
        <Callout tone="danger" className="mb-4">
          {recoveryBannerError}
        </Callout>
      )}

      {isConnected && status && (
        <div className="space-y-2 text-xs">
          {(provider === 'gdrive'
            ? status.email || status.lastSync || showStorageBlock
            : status.rootPath || status.lastSync) && (
            <div
              className="text-fg-muted flex flex-wrap items-center gap-x-3 gap-y-1"
              data-testid="gdrive-status-meta"
            >
              {provider === 'gdrive' && status.email && (
                <Tooltip content={t('gdrive.signed_in_as')} placement="top">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Mail className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                    <span className="text-fg truncate font-medium">{status.email}</span>
                  </span>
                </Tooltip>
              )}
              {provider && provider !== 'gdrive' && status.rootPath && (
                <Tooltip
                  content={provider === 'icloud' ? status.rootPath : t('cloud.folder_path_label')}
                  placement="top"
                >
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <HardDrive className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                    <span className="text-fg truncate font-medium">
                      {displayCloudRootPath(
                        provider,
                        status.rootPath,
                        t('cloud.providers.icloud.name'),
                      )}
                    </span>
                  </span>
                </Tooltip>
              )}
              {status.lastSync != null && (
                <Tooltip content={t('gdrive.last_sync')} placement="top">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                    <span>{formatDate(status.lastSync)}</span>
                  </span>
                </Tooltip>
              )}
              {provider === 'gdrive' && hasAppStorage && (
                <Tooltip content={t('gdrive.storage_app_usage_tooltip')} placement="top">
                  <span className="text-fg inline-flex items-center gap-1 font-medium">
                    <HardDrive className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                    <span>{formatBytes(status.storageAppUsed!)}</span>
                  </span>
                </Tooltip>
              )}
              {provider === 'gdrive' && storageUsage && (
                <Tooltip
                  content={t('gdrive.storage_drive_free_tooltip', {
                    free: formatBytes(storageUsage.freeBytes),
                    total: formatBytes(status.storageTotal!),
                  })}
                  placement="top"
                >
                  <span
                    className={cn(
                      'inline-flex items-center gap-1',
                      storageUsage.severity === 'warning' && 'text-warning-text',
                      storageUsage.severity === 'critical' && 'text-danger-text',
                    )}
                  >
                    <Cloud className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                    <span>
                      {t('gdrive.storage_drive_free_short', {
                        free: formatBytes(storageUsage.freeBytes),
                        percentage: storageUsage.freePercentage,
                      })}
                    </span>
                  </span>
                </Tooltip>
              )}
            </div>
          )}

          {provider === 'gdrive' && showCriticalQuotaNotice && (
            <Callout
              tone="danger"
              title={t('gdrive.storage_quota_notice.title')}
              action={
                <Button
                  aria-label={t('gdrive.storage_quota_notice.dismiss')}
                  icon={<X className="size-4" />}
                  onClick={dismissCriticalQuotaNotice}
                  size="xs"
                  variant="ghost"
                />
              }
            >
              <p>{t('gdrive.storage_quota_notice.body')}</p>
              <Button
                className="mt-2"
                onClick={() => setSettingsCategory('media')}
                size="xs"
                variant="secondary"
              >
                {t('gdrive.storage_quota_notice.media_settings')}
              </Button>
            </Callout>
          )}
        </div>
      )}

      {error && (
        <p className="text-danger-text mt-2 text-xs" role="alert">
          {error}
        </p>
      )}

      {connectSuccess && isConnected && (
        <p className="text-success-text mt-2 text-xs">{t('gdrive.success', i18nProvider)}</p>
      )}

      {!isConnected && (
        <div className="mt-3 space-y-3">
          <CloudProviderPicker
            value={selected}
            onChange={(kind) => {
              userTouchedProvider.current = true
              setSelected(kind)
            }}
            localPath={localPath}
            onPickFolder={() => {
              void handlePickFolder()
            }}
            icloudAvailable={pickerIcloud}
            disabled={isBusy}
          />
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder={t('gdrive.password_placeholder')}
            autoComplete="current-password"
            disabled={isBusy}
          />
        </div>
      )}

      {/* Disconnected: Connect only. Connected: Sync now / Disconnect / Help. */}
      <div className="my-3 flex flex-wrap gap-2">
        {!isConnected && (
          <Button size="xs" disabled={connectDisabled} onClick={handleConnectClick}>
            {isBusy
              ? t('gdrive.connecting')
              : isInitialLoading
                ? t('gdrive.loading')
                : t('cloud.connect_with', i18nProvider)}
          </Button>
        )}

        {!isConnected && selected === 'gdrive' && isAwaitingCallback && (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleCancelConnect}
            data-testid="gdrive-cancel-connect"
          >
            {t('gdrive.cancel_connect')}
          </Button>
        )}
      </div>

      {isConnected && (
        <SyncStatus
          className="mt-4 mb-2"
          isConnecting={false}
          actions={
            <>
              <Button
                variant="destructive"
                size="sm"
                disabled={actionsDisabled || isSyncing}
                onClick={() => setDisconnectConfirmOpen(true)}
                data-testid="cloud-disconnect"
              >
                {t('gdrive.disconnect')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionsDisabled}
                onClick={() => useSyncRecoveryWizardStore.getState().openWizard()}
                data-testid="gdrive-recovery-wizard-open"
              >
                {t('gdrive.recovery_wizard.card_button')}
              </Button>
            </>
          }
        />
      )}

      {showOpenSyncHelp && (
        <div className="mb-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={actionsDisabled}
            onClick={() => useSyncRecoveryWizardStore.getState().openWizard()}
            data-testid="gdrive-open-sync-help"
          >
            {t('gdrive.help.open_from_error')}
          </Button>
        </div>
      )}

      {disconnectConfirmOpen && (
        <Modal onClose={() => !isBusy && setDisconnectConfirmOpen(false)}>
          <Modal.Header
            description={
              <>
                {t('gdrive.disconnect_modal.body')}
                {provider === 'gdrive' ? (
                  <span className="mt-2 block">
                    {t('gdrive.disconnect_modal.body_gdrive_note')}
                  </span>
                ) : null}
              </>
            }
          >
            {t('gdrive.disconnect_modal.title', i18nProvider)}
          </Modal.Header>
          <Modal.Footer>
            <Button
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => setDisconnectConfirmOpen(false)}
            >
              {t('gdrive.recovery_wizard.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              loading={isBusy}
              data-testid="cloud-disconnect-confirm"
              onClick={() => {
                void handleReconnect()
              }}
            >
              {isBusy ? t('gdrive.disconnecting') : t('gdrive.disconnect_modal.confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {showOnboarding && (
        <Modal onClose={() => setShowOnboarding(false)} maxWidth={560}>
          <OnboardNewDeviceScreen
            chrome="modal"
            providerKind={connectKind}
            onCompleted={async () => {
              setShowOnboarding(false)
              const fresh = await gdriveGetStatus().catch(() => null)
              if (fresh) setStatus(fresh)
              setConnectSuccess(true)
              void useSyncStore
                .getState()
                .syncNow()
                .catch(() => {})
            }}
            onCancel={() => setShowOnboarding(false)}
          />
        </Modal>
      )}

      <SyncRecoveryWizard
        onStatusChanged={reloadStatus}
        onRecoveryConfirmed={runRecoveryToCompletionFromWizard}
        actionsDisabled={actionsDisabled}
      />
    </SettingsSection>
  )
}
