import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSync } from '../../hooks/useSync'
import type { SyncSettings } from '../../lib/tauri'
import { SegmentedControl } from '../common/SegmentedControl'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'
import { Toggle } from './Toggle'

const INTERVAL_OPTIONS = ['5', '15', '30', '60'] as const
type IntervalOption = (typeof INTERVAL_OPTIONS)[number]
const ROW = 'px-4'

// Coerce a stored interval to the nearest preset — legacy setups may hold a
// free-form value from the old number input.
function toIntervalOption(minutes: number): IntervalOption {
  if (INTERVAL_OPTIONS.includes(String(minutes) as IntervalOption)) {
    return String(minutes) as IntervalOption
  }
  const nearest = INTERVAL_OPTIONS.map(Number).reduce((a, b) =>
    Math.abs(b - minutes) < Math.abs(a - minutes) ? b : a,
  )
  return String(nearest) as IntervalOption
}

function intervalLabel(value: IntervalOption): string {
  return value === '60' ? '1h' : `${value}m`
}

/**
 * Scheduler-facing sync settings: interval, on-save, on-launch, plus enable.
 * Card-group layout matches AI / General settings.
 */
export function SyncSchedulerSettings() {
  const { t } = useTranslation('settings')
  const { settings, updateSettings, status, setEnabled } = useSync()
  const [enabledError, setEnabledError] = useState<string | null>(null)

  const syncEnabled = status?.enabled ?? false
  const hasProvider = !!status?.provider

  const handleToggleEnabled = async (next: boolean) => {
    setEnabledError(null)
    try {
      await setEnabled(next)
    } catch (err) {
      setEnabledError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col space-y-5">
      <SettingsGroup title={t('sync_scheduler.groups.master')}>
        <SettingsRow
          className={ROW}
          divider={false}
          title={t('sync_scheduler.enable_title')}
          hint={
            hasProvider
              ? t('sync_scheduler.enable_hint_connected')
              : t('sync_scheduler.enable_hint_no_provider')
          }
        >
          <Toggle
            checked={syncEnabled}
            onChange={(next) => void handleToggleEnabled(next)}
            ariaLabel={t('sync_scheduler.enable_aria')}
            disabled={!hasProvider}
          />
        </SettingsRow>
      </SettingsGroup>

      {enabledError && (
        <p role="alert" className="text-danger-text text-sm">
          {enabledError}
        </p>
      )}

      {settings && (
        <SchedulerForm
          key={`${settings.intervalMinutes}-${String(settings.onSave)}-${String(settings.onLaunch)}`}
          settings={settings}
          updateSettings={updateSettings}
        />
      )}
    </div>
  )
}

type UpdateFn = (next: SyncSettings) => Promise<void>

function SchedulerForm({
  settings,
  updateSettings,
}: {
  settings: SyncSettings
  updateSettings: UpdateFn
}) {
  const { t } = useTranslation('settings')
  const [saveError, setSaveError] = useState<string | null>(null)

  const save = async (next: Partial<SyncSettings>) => {
    setSaveError(null)
    try {
      await updateSettings({
        intervalMinutes: settings.intervalMinutes,
        onSave: settings.onSave,
        onLaunch: settings.onLaunch,
        ...next,
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleToggleOnSave = (next: boolean) => void save({ onSave: next })
  const handleToggleOnLaunch = (next: boolean) => void save({ onLaunch: next })

  const handleIntervalChange = (next: IntervalOption) =>
    void save({ intervalMinutes: Number(next) })

  return (
    <>
      <SettingsGroup title={t('sync_scheduler.groups.triggers')}>
        <SettingsRow
          className={ROW}
          divider={false}
          title={t('sync_scheduler.after_save_title')}
          hint={t('sync_scheduler.after_save_hint')}
        >
          <Toggle
            checked={settings.onSave}
            onChange={handleToggleOnSave}
            ariaLabel={t('sync_scheduler.after_save_aria')}
          />
        </SettingsRow>

        <SettingsRow
          className={ROW}
          divider={false}
          title={t('sync_scheduler.on_launch_title')}
          hint={t('sync_scheduler.on_launch_hint')}
        >
          <Toggle
            checked={settings.onLaunch}
            onChange={handleToggleOnLaunch}
            ariaLabel={t('sync_scheduler.on_launch_aria')}
          />
        </SettingsRow>

        <SettingsRow
          id="settings-anchor-sync-interval"
          className={ROW}
          divider={false}
          title={t('sync_scheduler.interval_title')}
          hint={t('sync_scheduler.interval_hint')}
        >
          <SegmentedControl<IntervalOption>
            ariaLabel={t('sync_scheduler.interval_title')}
            value={toIntervalOption(settings.intervalMinutes)}
            onChange={handleIntervalChange}
            commitOnArrow={false}
            options={INTERVAL_OPTIONS.map((value) => ({
              value,
              label: intervalLabel(value),
            }))}
          />
        </SettingsRow>
      </SettingsGroup>

      {saveError && (
        <p role="alert" className="text-danger-text text-sm">
          {saveError}
        </p>
      )}
    </>
  )
}
