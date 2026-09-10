import {
  Check,
  EyeOff,
  Flame,
  LockKeyhole,
  LockKeyholeOpen,
  PanelLeft,
  PanelRight,
  Unlock,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useActiveTab, useActiveView, useSelectedEntryId } from '../../hooks/useActiveTab'
import { isEditorDistractionShellActive } from '../../lib/editorDistraction'
import { useInvisibleLock } from '../../hooks/useInvisibleLock'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { useLockAction } from '../../hooks/useLockAction'
import { useSecondLock } from '../../hooks/useSecondLock'
import { useStreaks } from '../../hooks/useStreaks'
import { cn } from '../../lib/cn'
import { useEditorMetricsStore } from '../../stores/editorMetricsStore'
import { useEditorDistractionStore } from '../../stores/editorDistractionStore'
import { useGdriveConnectStore } from '../../stores/gdriveConnectStore'
import { useSyncStore } from '../../stores/syncStore'
import { useUiStore } from '../../stores/uiStore'
import { BasemapStatus } from '../common/BasemapStatus'
import { EmbeddingStatus } from '../common/EmbeddingStatus'
import { AIProviderInfoPopover } from '../common/AIProviderInfoPopover'
import { OnDeviceLlmStatus } from '../common/OnDeviceLlmStatus'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { ShimmerText } from '../common/ShimmerText'
import { SyncStatus } from '../common/SyncStatus'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { IconButton } from '../common/primitives'

// Streak tone tiers: < 5 days = neutral (cold), 5–20 = warming up (amber),
// > 20 = on fire (violet). Light mode needs higher opacity because the footer
// chrome is near-white — dark mode keeps the subtler panel-tint palette.
function streakToneClasses(streak: number): string {
  if (streak > 20) {
    return 'border-accent bg-accent/15 dark:bg-accent-soft text-accent-text'
  }
  if (streak >= 5) {
    return 'border-warning-border bg-warning-bg text-warning-fg'
  }
  return 'border-fg/[0.12] bg-fg/[0.06] dark:border-border-default dark:bg-panel-1 text-fg-muted'
}

/**
 * Global 32px glass footer strip. Always visible at the bottom of the
 * app shell. Replaces the per-editor bottom status strip from Phase 1–3.
 *
 * Left cluster:  compact <SyncStatus/> + <EmbeddingStatus/>
 * Middle:        streak pill (flame icon + current streak number)
 * Right cluster: active-entry metadata — word count, char count,
 *                save-state dot + label (hidden when no entry selected).
 */
export function FooterBar() {
  const { t } = useTranslation('nav')
  const { streakInfo } = useStreaks()
  const { lock, lockBlockedReason } = useLockAction()
  const secondLock = useSecondLock(false)
  const invisibleLock = useInvisibleLock(false)
  const { sidebarCollapsed, toggleSidebar } = useUiStore()
  const { sidebarRight } = useLayoutFlags()
  // A key rotation (revoke / reset / rotate) runs in the background; surface it
  // here so the user has a persistent "working" signal after the modal closes.
  const rotationBusy = useUiStore((s) => s.rotationBusy)
  // Device rename (esp. current device + Drive slot re-upload) runs in the
  // background after the rename modal closes — same footer pattern.
  const deviceRenameBusy = useUiStore((s) => s.deviceRenameBusy)
  // Device removal queues behind an in-flight sync and keeps running after
  // the secure wizard closes — same footer pattern.
  const deviceRemovalBusy = useUiStore((s) => s.deviceRemovalBusy)
  const distractionMode = useEditorDistractionStore((s) => s.distractionMode)
  const activeView = useActiveView()
  const selectedEntryId = useSelectedEntryId()
  const distractionShellActive = isEditorDistractionShellActive(
    distractionMode,
    selectedEntryId,
    activeView,
  )
  const activeTab = useActiveTab()
  const [secondLockPromptOpen, setSecondLockPromptOpen] = useState(false)

  // Google Drive connect in flight. Until the backend finishes the post-OAuth
  // I/O and the sync store flips `enabled` to true, the footer would otherwise
  // read the not-yet-enabled state as the misleading "Sync off". Covers both
  // entry points: the onboarding background connect (`status`) and a
  // Settings-initiated connect (`manualConnecting`). Keep showing "Connecting…"
  // through the onboarding `success` window too, until `enabled` actually turns
  // on — this bridges the flash between connect success and the first backend
  // sync event.
  const connectStatus = useGdriveConnectStore((s) => s.status)
  const manualConnecting = useGdriveConnectStore((s) => s.manualConnecting)
  const syncEnabled = useSyncStore((s) => s.status?.enabled ?? false)
  const isConnecting =
    manualConnecting ||
    connectStatus === 'connecting' ||
    (connectStatus === 'success' && !syncEnabled)

  // Live counts from the editor — updated on every keystroke. Select
  // primitives (not a fresh object) so zustand's default reference-equality
  // check doesn't trigger an infinite render loop.
  const metricsEntryId = useEditorMetricsStore((s) => s.entryId)
  const metricsWords = useEditorMetricsStore((s) => s.words)
  const metricsChars = useEditorMetricsStore((s) => s.chars)
  const metricsAreFresh = metricsEntryId === selectedEntryId
  const words = metricsAreFresh ? metricsWords : 0
  const chars = metricsAreFresh ? metricsChars : 0

  const hasSelection = selectedEntryId !== null
  const isDirty = activeTab?.dirty === true

  // Lock-eligibility policy lives in `useLockAction` so the footer
  // button and the ⌘⇧L shortcut handler can't drift apart. Map each
  // blocked-reason to its tooltip string here.
  const lockDisabled = lockBlockedReason !== null
  const lockTooltip =
    lockBlockedReason === 'no-password'
      ? t('sidebar.lock_app_disabled')
      : lockBlockedReason === 'saving'
        ? t('sidebar.lock_app_saving')
        : t('sidebar.lock_app_with_shortcut')

  const SidebarToggleIcon = sidebarRight
    ? sidebarCollapsed
      ? PanelRight
      : PanelLeft
    : sidebarCollapsed
      ? PanelLeft
      : PanelRight

  const sidebarToggle = (
    <Tooltip
      content={
        distractionShellActive
          ? t('sidebar.toggle_disabled_distraction')
          : sidebarCollapsed
            ? t('sidebar.expand')
            : t('sidebar.collapse')
      }
      placement="top"
    >
      <IconButton
        aria-label={
          distractionShellActive
            ? t('sidebar.toggle_disabled_distraction')
            : sidebarCollapsed
              ? t('sidebar.expand')
              : t('sidebar.collapse')
        }
        disabled={distractionShellActive}
        onClick={toggleSidebar}
      >
        <SidebarToggleIcon className="size-4" />
      </IconButton>
    </Tooltip>
  )

  return (
    <footer
      className={cn(
        // SuperX chrome bar: darker than canvas, hairline top border, muted meta.
        'bg-chrome shadow-edge-top border-border-default text-fg-muted flex shrink-0 items-center justify-between gap-3 overflow-hidden border-t px-2 text-xs transition-[height,opacity,border-color] duration-(--motion-duration-slow) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
        distractionShellActive
          ? 'pointer-events-none h-0 border-transparent opacity-0'
          : 'h-10 opacity-100',
      )}
      aria-hidden={distractionShellActive}
      data-testid="footer-bar"
    >
      {/* Left: sidebar toggle + lock + sync status */}
      <div className="flex min-w-0 items-center gap-1">
        {!sidebarRight && sidebarToggle}
        <Tooltip content={lockTooltip} placement="top">
          <IconButton
            aria-label={t('sidebar.lock_app')}
            disabled={lockDisabled}
            onClick={() => void lock()}
          >
            <Unlock className="text-accent size-4" />
          </IconButton>
        </Tooltip>
        {secondLock.isEnabled && (
          <Tooltip
            content={
              secondLock.isSessionUnlocked
                ? t('sidebar.lock_second_lock')
                : t('sidebar.unlock_second_lock')
            }
            placement="top"
          >
            <IconButton
              aria-label={
                secondLock.isSessionUnlocked
                  ? t('sidebar.lock_second_lock')
                  : t('sidebar.unlock_second_lock')
              }
              onClick={() => {
                if (secondLock.isSessionUnlocked) {
                  secondLock.lock()
                } else {
                  setSecondLockPromptOpen(true)
                }
              }}
            >
              {secondLock.isSessionUnlocked ? (
                <LockKeyholeOpen className="text-accent size-4" />
              ) : (
                <LockKeyhole className="size-4" />
              )}
            </IconButton>
          </Tooltip>
        )}
        {invisibleLock.activeVaultId != null && (
          <Tooltip content={t('sidebar.lock_invisible_tooltip')} placement="top">
            <IconButton
              aria-label={t('sidebar.lock_invisible')}
              onClick={() => invisibleLock.lock()}
            >
              <EyeOff className="text-accent size-4" />
            </IconButton>
          </Tooltip>
        )}
        <SyncStatus compact isConnecting={isConnecting} />
        <EmbeddingStatus compact />
        <OnDeviceLlmStatus compact />
        <BasemapStatus compact />
        {rotationBusy && (
          <span
            data-testid="footer-rotating"
            aria-live="polite"
            className="text-fg-muted ml-1 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <InlineOrb state="searching" aria-hidden />
            <ShimmerText className="text-xs font-medium">{t('footer.rotating')}</ShimmerText>
          </span>
        )}
        {deviceRenameBusy && (
          <span
            data-testid="footer-renaming"
            aria-live="polite"
            className="text-fg-muted ml-1 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <InlineOrb state="searching" aria-hidden />
            <ShimmerText className="text-xs font-medium">{t('footer.renaming')}</ShimmerText>
          </span>
        )}
        {deviceRemovalBusy && (
          <span
            data-testid="footer-removing-device"
            aria-live="polite"
            className="text-fg-muted ml-1 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <InlineOrb state="searching" aria-hidden />
            <ShimmerText className="text-xs font-medium">{t('footer.removing_device')}</ShimmerText>
          </span>
        )}
      </div>

      {/* Right: active-entry metadata */}
      <div data-testid="footer-metadata" className="flex min-w-0 items-center gap-2 text-sm">
        {hasSelection && (
          <>
            <span className="text-fg-muted font-mono">{t('footer.words', { count: words })}</span>
            <span className="text-fg-muted font-mono">{t('footer.chars', { count: chars })}</span>
            <span
              data-testid="footer-save-state"
              className={cn('inline-flex items-center gap-1 font-mono', {
                'text-warning': isDirty,
                'text-success': !isDirty,
              })}
            >
              {!isDirty && <Check className="size-3" aria-hidden />}
              <span className={isDirty ? 'animate-pulse motion-reduce:animate-none' : undefined}>
                {isDirty ? t('footer.saving') : t('footer.saved')}
              </span>
            </span>
          </>
        )}
        {!distractionShellActive && <AIProviderInfoPopover />}
        <Tooltip content={t('streak.tooltip')} placement="top">
          <div
            data-testid="footer-streak"
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs font-semibold',
              streakToneClasses(streakInfo?.current_streak ?? 0),
            )}
            aria-label={t('streak.footer_label', { count: streakInfo?.current_streak ?? 0 })}
          >
            <Flame className="size-4" strokeWidth={1.75} />
            <span>{streakInfo?.current_streak ?? 0}</span>
          </div>
        </Tooltip>
        {sidebarRight && sidebarToggle}
      </div>
      <SecondLockPromptModal
        open={secondLockPromptOpen}
        onClose={() => setSecondLockPromptOpen(false)}
        title={t('sidebar.unlock_second_lock')}
        description={t('sidebar.unlock_second_lock_description')}
        mode="unlock-session"
        onVerified={() => setSecondLockPromptOpen(false)}
      />
    </footer>
  )
}
