import { useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Pencil, RefreshCw, ShieldOff, X } from 'lucide-react'
import type { DeviceInfo } from '../../hooks/useDeviceList'
import { Button } from '../common/Button'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { RenameDeviceModal } from './RenameDeviceModal'
import { SettingsSection } from './SettingsSection'
import { useSecureWizardStore } from '../../stores/secureWizardStore'
import { useUiStore } from '../../stores/uiStore'

type Props = {
  devices: DeviceInfo[]
  error: string | null
  onRename: (deviceId: string, newName: string) => Promise<void>
  onRefresh: () => Promise<void>
}

/** Format a Unix timestamp (seconds) as a localized short relative string. */
function formatRelative(unixSeconds: number, t: TFunction<'settings'>): string {
  const now = Date.now() / 1000
  const diff = now - unixSeconds

  if (diff < 60) return t('security.devices.relative.just_now')
  if (diff < 3600) {
    const mins = Math.floor(diff / 60)
    return t('security.devices.relative.minutes_ago', { count: mins })
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600)
    return t('security.devices.relative.hours_ago', { count: hours })
  }
  if (diff < 86400 * 30) {
    const days = Math.floor(diff / 86400)
    return t('security.devices.relative.days_ago', { count: days })
  }
  // Fall back to absolute date for old timestamps.
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Format a Unix timestamp (seconds) as an absolute date string. */
function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

interface RenameState {
  deviceId: string
  currentName: string
}

export function DeviceList({ devices, error, onRename, onRefresh }: Props) {
  const { t } = useTranslation('settings')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  // Shared cross-action locks: background key rotation, rename, or removal
  // disables every actionable button in this list (including Revoke).
  const rotationBusy = useUiStore((s) => s.rotationBusy)
  const deviceRenameBusy = useUiStore((s) => s.deviceRenameBusy)
  const deviceRemovalBusy = useUiStore((s) => s.deviceRemovalBusy)
  const deviceRemovalOutcome = useUiStore((s) => s.deviceRemovalOutcome)
  const actionsDisabled = rotationBusy || deviceRenameBusy || deviceRemovalBusy

  // A just-revoked device is marked `is_revoked` locally (not deleted) and
  // `list_devices` still returns it until a later cloud refresh prunes it.
  // Hide revoked rows immediately so the user doesn't see the device linger.
  const visibleDevices = devices.filter((d) => !d.is_revoked)

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setIsRefreshing(false)
    }
  }

  const openRename = (device: DeviceInfo) => {
    setRenameState({ deviceId: device.device_id, currentName: device.name })
  }

  const closeRename = () => setRenameState(null)

  // Forward only — modal closes itself without awaiting Drive I/O.
  const handleRename = (deviceId: string, newName: string) => onRename(deviceId, newName)

  return (
    <SettingsSection
      title={t('security.devices.title')}
      hint={t('security.devices.subtitle')}
      titleAccessory={
        <Tooltip
          content={isRefreshing ? t('security.devices.refreshing') : t('security.devices.refresh')}
          placement="bottom"
        >
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void handleRefresh()}
            // Pass `undefined` (not `false`) when idle so Button's
            // `disabled={disabled ?? loading}` still disables while refreshing.
            disabled={actionsDisabled || undefined}
            loading={isRefreshing}
            aria-label={t('security.devices.refresh')}
            icon={<RefreshCw className="size-4" strokeWidth={1.75} />}
          />
        </Tooltip>
      }
    >
      <div className="space-y-3">
        {deviceRenameBusy && (
          <div
            className="flex items-center gap-2"
            aria-live="polite"
            data-testid="devices-renaming"
          >
            <InlineOrb state="searching" aria-hidden />
            <p className="text-fg-muted text-sm leading-relaxed">
              {t('security.devices.renaming')}
            </p>
          </div>
        )}

        {deviceRemovalBusy && (
          <div
            className="flex items-center gap-2"
            aria-live="polite"
            data-testid="devices-removing"
          >
            <InlineOrb state="searching" aria-hidden />
            <p className="text-fg-muted text-sm leading-relaxed">
              {t('security.secure_wizard.remove.running')}
            </p>
          </div>
        )}

        {deviceRemovalOutcome && (
          <div
            className="flex items-start justify-between gap-2"
            role="status"
            data-testid="devices-removal-outcome"
          >
            <p
              className={`text-sm leading-relaxed ${
                deviceRemovalOutcome === 'error' ? 'text-danger-text' : 'text-fg-secondary'
              }`}
            >
              {t(
                deviceRemovalOutcome === 'ok'
                  ? 'security.devices.remove_outcome_ok'
                  : 'security.devices.remove_outcome_error',
              )}
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => useUiStore.getState().setDeviceRemovalOutcome(null)}
              aria-label={t('security.devices.remove_outcome_dismiss')}
            >
              <X className="size-4" strokeWidth={1.75} />
            </Button>
          </div>
        )}

        {error && <p className="text-danger-text text-sm">{error}</p>}

        {visibleDevices.length > 0 && (
          <ul className="border-border-card bg-surface-hi divide-border-default divide-y overflow-hidden rounded-2xl border">
            {visibleDevices.map((device) => (
              <li
                key={device.device_id}
                className="hover:bg-surface-row-hover flex items-start justify-between gap-3 px-4 py-3 transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-fg truncate text-sm font-medium">{device.name}</span>
                    {device.is_current && (
                      <span className="bg-accent/15 text-accent shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
                        {t('security.devices.this_device')}
                      </span>
                    )}
                  </div>
                  <div className="text-fg-muted mt-0.5 flex flex-col gap-0.5 text-xs">
                    <span>
                      {t('security.devices.created_at', { date: formatDate(device.created_at) })}
                    </span>
                    <span>
                      {t('security.devices.last_seen', {
                        relative: formatRelative(device.last_seen_at, t),
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Tooltip content={t('security.devices.rename')} placement="bottom">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => openRename(device)}
                      disabled={actionsDisabled}
                      aria-label={t('security.devices.rename')}
                    >
                      <Pencil className="size-4" strokeWidth={1.75} />
                    </Button>
                  </Tooltip>
                  {!device.is_current && (
                    <Tooltip content={t('security.devices.remove_or_revoke')} placement="bottom">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          useSecureWizardStore.getState().openForDevice({
                            deviceId: device.device_id,
                            deviceName: device.name,
                          })
                        }
                        disabled={actionsDisabled}
                        aria-label={t('security.devices.remove_or_revoke')}
                      >
                        <ShieldOff className="size-4" strokeWidth={1.75} />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {renameState && (
        <RenameDeviceModal
          open
          deviceId={renameState.deviceId}
          currentName={renameState.currentName}
          onRename={handleRename}
          onClose={closeRename}
        />
      )}
    </SettingsSection>
  )
}
