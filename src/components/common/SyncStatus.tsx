import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useSync } from '../../hooks/useSync'
import { useSyncStore } from '../../stores/syncStore'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useForceRePairStore } from '../../hooks/useForceRePair'
import { RefreshCw, AlertCircle, CloudUpload, Cloud, CloudOff, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { ShimmerText } from './ShimmerText'
import { InlineOrb } from './ThinkingOrb'
import { Tooltip } from './Tooltip'

const SYNC_ICONS = {
  RefreshCw,
  AlertCircle,
  CloudUpload,
  // lucide-react < 0.408 doesn't expose CloudCheck — use Cloud as the resting icon
  CloudCheck: Cloud,
  CloudOff,
} satisfies Record<string, LucideIcon>

interface SyncStatusProps {
  /**
   * When true, render the compact sidebar variant — one line, icon +
   * short label. When false, render a wider panel suitable for
   * settings / debug UI.
   */
  compact?: boolean
  className?: string
  /** Google Drive OAuth in flight — replace the misleading "Sync off" row. */
  isConnecting?: boolean
  /** Extra panel buttons rendered in the same row as Sync now. */
  actions?: ReactNode
}

/**
 * Lightweight wrapper that translates the `useSync` state machine into
 * user-facing copy + the right icon. The component is stateless — all
 * state lives in the hook, which is driven by Tauri lifecycle events.
 *
 * Four display states:
 *   - `disabled`  — sync not configured yet; show a muted "Sync off" row.
 *   - `syncing`   — show a spinning icon and the in-flight label.
 *   - `error`     — show the warning icon + most recent error text.
 *   - `synced`    — show the checkmark + a human-friendly "last synced N ago"
 *                   or "up to date" when we have no timestamp yet.
 *
 * The sidebar variant also renders a "Sync now" button; the panel variant
 * renders it below the status line.
 */
/**
 * Renders the sync status icon. When sync is in flight (or recovery is
 * running) this shows the "composing" thinking-orb instead of a spinning
 * RefreshCw. Resting / error / pending states keep their static lucide icon.
 */
function SyncStatusIcon({
  spin,
  icon: Icon,
  tone,
}: {
  spin: boolean
  icon: LucideIcon
  tone: string
}) {
  // The orb resolves its own ink via the app theme — it ignores `tone`
  // (text-* classes have no effect on canvas). Only the static lucide icon
  // below uses `tone`. The orb's auto palette matches the resting row tone.
  if (spin) return <InlineOrb state="composing" aria-hidden />
  return <Icon className={cn('size-4', tone)} strokeWidth={1.75} />
}

export function SyncStatus({
  compact = false,
  className,
  isConnecting = false,
  actions,
}: SyncStatusProps) {
  const { t } = useTranslation('nav')
  const {
    status,
    phase,
    isSyncing,
    lastError,
    lastErrorKey,
    lastErrorAction,
    syncNow,
    progress,
    lastSummary,
    recoveryBlocksSync,
    retryAt,
  } = useSync()
  const syncControlsDisabled = isSyncing || recoveryBlocksSync
  // Until the store finishes its initial fetch, `status` is null and we can't
  // tell "sync is off" from "we don't know yet". Show a loading row in that
  // window instead of the misleading "Sync off".
  const initialized = useSyncStore((s) => s.initialized)
  const updateActiveTab = useUpdateActiveTab()

  // Prefer the i18n key over the raw backend string. Frontend-originated
  // errors (e.g. the watchdog timeout) set `lastErrorKey` so the message
  // localizes at render time and a language switch retranslates without
  // re-firing the source error. Raw backend strings remain in `lastError`.
  const resolvedError = lastErrorKey ? t(lastErrorKey) : lastError

  // Compute the retry label from the scheduler's backoff ETA.
  const retryLabel = (() => {
    if (!retryAt) return null
    const remainMs = retryAt - Date.now()
    if (remainMs <= 0) return t('sync.retry_soon')
    const mins = Math.ceil(remainMs / 60_000)
    return mins >= 1 ? t('sync.retry_in', { count: mins }) : t('sync.retry_soon')
  })()

  // Initial startup: store hasn't fetched the real status yet. Show a neutral
  // "loading" row so the user doesn't misread the not-yet-known state as
  // "Sync off".
  if (!initialized && !status) {
    return (
      <div className="flex items-center gap-2 py-0" data-testid="sync-status" data-state="loading">
        <span className="text-fg-muted shrink-0">
          <Cloud className="size-4" strokeWidth={1.75} />
        </span>
        <span className="text-fg-muted text-sm">{t('sync.loading')}</span>
      </div>
    )
  }

  if (!status || !status.enabled) {
    if (isConnecting) {
      if (compact) {
        return (
          <div
            className="text-fg-muted flex h-7 shrink-0 items-center gap-1.5 px-2"
            data-testid="sync-status"
            data-state="connecting"
          >
            <InlineOrb state="composing" aria-hidden />
            <ShimmerText className="text-xs font-medium">{t('sync.connecting')}</ShimmerText>
          </div>
        )
      }

      return (
        <div
          className={cn('flex items-center gap-2 py-0', className)}
          data-testid="sync-status"
          data-state="connecting"
        >
          <InlineOrb state="composing" aria-hidden />
          <ShimmerText className="text-sm">{t('sync.connecting')}</ShimmerText>
        </div>
      )
    }

    // Footer (compact): sync not configured has nothing actionable to say, so
    // render nothing instead of a persistent "Sync off". The footer only
    // surfaces sync while it's connecting / syncing / synced / pending / error.
    if (compact) return null

    return (
      <div className="flex items-center gap-2 py-0" data-testid="sync-status" data-state="disabled">
        <span className="text-fg-muted shrink-0">
          <CloudOff className="size-4" strokeWidth={1.75} />
        </span>
        <span className="text-fg-muted text-sm">{t('sync.off')}</span>
      </div>
    )
  }

  const displayPhase = isSyncing ? 'syncing' : phase
  const hasPending = status.entriesPending > 0
  const hasError = displayPhase === 'error' || !!resolvedError

  // Authoritative recovery takes priority over ordinary sync chrome so Sync
  // Now blocked by recovery is never mislabeled as "sync in progress".
  const iconName = recoveryBlocksSync
    ? 'RefreshCw'
    : displayPhase === 'syncing'
      ? 'RefreshCw'
      : hasError
        ? 'AlertCircle'
        : hasPending
          ? 'CloudUpload'
          : 'CloudCheck'

  const label = recoveryBlocksSync
    ? t('sync.recovery_in_progress')
    : displayPhase === 'syncing'
      ? isSyncing && progress
        ? `${t(`sync.progress.${progress.phase}`)} ${progress.current}/${progress.total}`
        : t('sync.syncing')
      : hasError
        ? t('sync.error')
        : hasPending
          ? t('sync.pending', { count: status.entriesPending })
          : formatSyncedLabel(status.lastSync, t)

  const summaryTooltip =
    !recoveryBlocksSync && displayPhase !== 'syncing' && !hasError && lastSummary
      ? t('sync.last_summary', {
          pushed: lastSummary.pushed,
          pulled: lastSummary.pulled,
          merged: lastSummary.merged,
        })
      : null

  // Don't show the error (red) tone while a sync is actively in flight — a
  // lingering `lastError` from a prior attempt must not paint a healthy
  // in-progress push red. Matches the error-message guard below (`!isSyncing`).
  // Recovery is informative (blocks Sync Now), not an error — keep secondary tone.
  const statusTone = recoveryBlocksSync
    ? 'text-fg-secondary'
    : hasError && !isSyncing
      ? 'text-danger-text'
      : 'text-fg-secondary'

  const isForceRePair = lastErrorAction?.kind === 'force_re_pair_required'

  // Human-friendly, localised message for force-re-pair errors. Replaces the
  // raw backend string so the user sees a clear, actionable description.
  const forceRePairMessage =
    lastErrorAction?.kind === 'force_re_pair_required'
      ? lastErrorAction.reason === 'inconclusive'
        ? t('sync.force_re_pair_inconclusive')
        : t('sync.force_re_pair_rotated')
      : null

  const openSyncSettings = () => {
    updateActiveTab({ activeView: 'settings', selectedEntryId: null, settingsCategory: 'sync' })
  }

  const handleRepair = () => {
    if (lastErrorAction?.kind === 'force_re_pair_required') {
      // Map the short reason class to the backend long-form reason code. App
      // routes on it: `vault_rotated` needs the 24-word phrase
      // (ForceRePairScreen), anything else only needs a Drive reconnect
      // (ReconnectDriveScreen).
      const reasonCode =
        lastErrorAction.reason === 'inconclusive' ? 'keyring_check_inconclusive' : 'vault_rotated'
      useForceRePairStore.getState().setForceRePair(reasonCode)
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Recovery blocks Sync Now — route to Settings so the user can resume/cancel.
    if (recoveryBlocksSync) {
      openSyncSettings()
      return
    }
    if (syncControlsDisabled) return
    // Force-re-pair: clicking the compact pill routes to Repair (via Settings → Sync
    // where the Repair button is visible), not a pointless syncNow retry.
    if (compact && isForceRePair) {
      openSyncSettings()
      return
    }
    // When the compact pill is in an error state, clicking it would
    // immediately retry — which clears the error message before the
    // user can read it. Route to Settings → Sync instead so the full
    // error stays visible.
    if (compact && hasError) {
      openSyncSettings()
      return
    }
    void syncNow().catch(() => {
      /* Error is surfaced via the lifecycle event; no extra handling. */
    })
  }

  const SyncIcon = SYNC_ICONS[iconName]
  const showSpin = recoveryBlocksSync || displayPhase === 'syncing'

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={isSyncing && !recoveryBlocksSync}
        aria-label={
          recoveryBlocksSync
            ? t('sync.view_recovery_details')
            : isSyncing
              ? t('sync.sync_in_progress')
              : hasError
                ? t('sync.view_error_details')
                : t('sync.sync_now')
        }
        data-testid="sync-status"
        data-state={recoveryBlocksSync ? 'recovery' : displayPhase}
        className={cn(
          'text-fg-muted hover:bg-surface-subtle hover:text-fg flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2 transition-colors duration-150',
          'disabled:hover:text-fg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        )}
        // While a sync/recovery is in flight (the orb is showing) the button is
        // disabled only to block re-clicks — keep it at full opacity so the
        // composing orb and shimmering label stay clearly visible (overrides the
        // `disabled:opacity-40` utility via inline style).
        style={{ opacity: showSpin ? 1 : undefined }}
      >
        <span className="flex shrink-0">
          <SyncStatusIcon spin={showSpin} icon={SyncIcon} tone={statusTone} />
        </span>
        {summaryTooltip ? (
          <Tooltip content={summaryTooltip} placement="top">
            <ShimmerText
              active={showSpin}
              className={cn('text-sm font-medium', !showSpin && statusTone)}
            >
              {label}
            </ShimmerText>
          </Tooltip>
        ) : hasError && !isSyncing && retryLabel ? (
          <Tooltip content={`${resolvedError} · ${retryLabel}`} placement="top">
            <ShimmerText
              active={showSpin}
              className={cn('text-xs font-medium', !showSpin && statusTone)}
            >
              {retryLabel}
            </ShimmerText>
          </Tooltip>
        ) : (
          <ShimmerText
            active={showSpin}
            className={cn('text-xs font-medium', !showSpin && statusTone)}
          >
            {label}
          </ShimmerText>
        )}
      </button>
    )
  }

  return (
    <div
      className={cn(
        'border-border-default bg-elevated flex flex-col items-start justify-between gap-2 rounded-2xl border p-4',
        className,
      )}
      data-testid="sync-status"
      data-state={recoveryBlocksSync ? 'recovery' : displayPhase}
    >
      <div className="flex items-center gap-3">
        <span className="flex shrink-0">
          <SyncStatusIcon spin={showSpin} icon={SyncIcon} tone={statusTone} />
        </span>
        <div className="flex flex-col">
          {summaryTooltip ? (
            <Tooltip content={summaryTooltip} placement="top">
              <ShimmerText
                active={showSpin}
                className={cn('text-sm font-medium', !showSpin && statusTone)}
              >
                {label}
              </ShimmerText>
            </Tooltip>
          ) : (
            <ShimmerText
              active={showSpin}
              className={cn('text-sm font-medium', !showSpin && statusTone)}
            >
              {label}
            </ShimmerText>
          )}
          {hasError && !isSyncing && !recoveryBlocksSync && (
            <span className="text-fg-muted mt-0.5 text-sm">
              {forceRePairMessage ?? resolvedError}
              {retryLabel && !forceRePairMessage && (
                <>
                  {' · '}
                  {retryLabel}
                </>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={
            recoveryBlocksSync ? openSyncSettings : isForceRePair ? handleRepair : handleClick
          }
          disabled={isSyncing && !recoveryBlocksSync && !isForceRePair}
          className="whitespace-nowrap"
        >
          {t(
            recoveryBlocksSync
              ? 'sync.view_recovery'
              : isForceRePair
                ? 'sync.repair'
                : 'sync.sync_now',
          )}
        </Button>
        {actions}
      </div>
    </div>
  )
}

/**
 * Render "last synced 5m ago" / "just now" / "up to date" for a unix
 * timestamp in seconds. Null → "up to date" so a freshly-configured
 * provider doesn't show an alarming empty state.
 */
function formatSyncedLabel(lastSync: number | null, t: TFunction<'nav'>): string {
  if (lastSync === null) return t('sync.up_to_date')
  const deltaSec = Math.max(0, Math.floor(Date.now() / 1000 - lastSync))
  if (deltaSec < 60) return t('sync.just_synced')
  if (deltaSec < 3600) return t('sync.minutes_ago', { count: Math.floor(deltaSec / 60) })
  if (deltaSec < 86400) return t('sync.hours_ago', { count: Math.floor(deltaSec / 3600) })
  return t('sync.days_ago', { count: Math.floor(deltaSec / 86400) })
}
