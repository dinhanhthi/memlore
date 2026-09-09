import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceList } from '../../hooks/useDeviceList'
import { RestoredScroll } from '../common/RestoredScroll'
import { cn } from '../../lib/cn'
import { useSyncStore } from '../../stores/syncStore'
import { useTabStore } from '../../stores/tabStore'
import { type SyncTab } from '../../stores/uiStore'
import { DeviceList } from './DeviceList'
import { GoogleDriveSettings } from './GoogleDriveSettings'
import { SyncSchedulerSettings } from './SyncSchedulerSettings'
import { SettingsTabList } from './SettingsTabList'
import { useTabSlideDirection } from './useTabSlideDirection'

const SYNC_TABS: { id: SyncTab; labelKey: string; defaultLabel: string }[] = [
  { id: 'gdrive', labelKey: 'sync_section.tabs.cloud', defaultLabel: 'Cloud Provider' },
  { id: 'devices', labelKey: 'sync_section.tabs.devices', defaultLabel: 'Devices' },
  { id: 'schedule', labelKey: 'sync_section.tabs.schedule', defaultLabel: 'Schedule' },
]

function syncTabId(id: SyncTab) {
  return `sync-tab-${id}`
}
function syncPanelId(id: SyncTab) {
  return `sync-panel-${id}`
}

/// `SyncSettings` — tabbed cloud sync settings (mirrors Security / Data layout):
/// 1. Cloud Service — connect, status, and danger-zone actions
/// 2. Devices — vault device slots (only when a provider is connected)
/// 3. Schedule — enable sync and scheduler intervals
export function SyncSettings() {
  const { t } = useTranslation('settings')
  const showDevices = useSyncStore(
    (s) => (s.status?.enabled ?? false) && s.status?.provider != null,
  )

  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.syncTab ?? 'gdrive'
  })
  const setActiveTab = (tab: SyncTab) => useTabStore.getState().updateActiveTab({ syncTab: tab })

  const visibleTabs = useMemo(
    () => SYNC_TABS.filter((tab) => tab.id !== 'devices' || showDevices),
    [showDevices],
  )

  const resolvedActiveTab = visibleTabs.some((tab) => tab.id === activeTab) ? activeTab : 'gdrive'

  const {
    devices,
    error: devicesError,
    rename,
    refresh,
  } = useDeviceList({
    active: resolvedActiveTab === 'devices' && showDevices,
  })

  const slideDir = useTabSlideDirection(
    visibleTabs.map((tab) => tab.id),
    resolvedActiveTab,
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">{t('categories.sync.label')}</h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.sync.description')}
        </p>
      </div>

      <SettingsTabList
        tabs={visibleTabs.map((tab) => ({
          id: tab.id,
          label: t(tab.labelKey, { defaultValue: tab.defaultLabel }),
        }))}
        activeTab={resolvedActiveTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.sync')}
        tabId={syncTabId}
        panelId={syncPanelId}
      />

      <div className="min-h-0 flex-1">
        {SYNC_TABS.map((tab) => {
          const isActive = resolvedActiveTab === tab.id
          const isVisible = tab.id !== 'devices' || showDevices
          if (!isVisible) return null

          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`sync:${tab.id}`}
              id={syncPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={syncTabId(tab.id)}
              aria-hidden={!isActive}
              inert={!isActive}
              tabIndex={0}
              style={{ display: isActive ? 'block' : 'none' }}
              className={cn(
                'h-full overflow-y-auto p-6 outline-none',
                isActive && slideDir === 'right' && 'tab-slide-in-right',
                isActive && slideDir === 'left' && 'tab-slide-in-left',
              )}
            >
              <div className="max-w-180">
                {tab.id === 'gdrive' && <GoogleDriveSettings />}
                {tab.id === 'devices' && (
                  <DeviceList
                    devices={devices}
                    error={devicesError}
                    onRename={rename}
                    onRefresh={refresh}
                  />
                )}
                {tab.id === 'schedule' && <SyncSchedulerSettings />}
              </div>
            </RestoredScroll>
          )
        })}
      </div>
    </div>
  )
}
