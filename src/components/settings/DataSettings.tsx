import { lazy, Suspense, useEffect, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'

import { RestoredScroll } from '../common/RestoredScroll'
import { cn } from '../../lib/cn'
import { asCloudProviderKind, providerLabel } from '../../lib/providerLabel'
import { useSyncStore } from '../../stores/syncStore'
import { DownloadsSettings } from './data/DownloadsSettings'
import { ExportModal } from './data/ExportModal'
import { ImportModal } from './data/ImportModal'
import { SettingsTabList } from './SettingsTabList'
import { useTabSlideDirection } from './useTabSlideDirection'
import { useTabStore } from '../../stores/tabStore'
import { coerceDataTab, type DataTab } from '../../stores/uiStore'

// DEV-only seed UI. Vite replaces `import.meta.env.DEV` with `false` in
// production so the dynamic `import('./SeedDemoCard')` branch is dead-code
// eliminated — production never ships the seed button or `seedDemoData` invoke.
const SeedDemoCard: ComponentType | null = import.meta.env.DEV
  ? lazy(() =>
      import('./SeedDemoCard').then((m) => ({
        default: m.SeedDemoCard,
      })),
    )
  : null

// ─── Tab IDs ─────────────────────────────────────────────────────────────────

const BASE_DATA_TABS: { id: DataTab; labelKey: string; defaultLabel: string }[] = [
  { id: 'import', labelKey: 'data_section.tabs.import', defaultLabel: 'Import' },
  { id: 'export', labelKey: 'data_section.tabs.export', defaultLabel: 'Export' },
  { id: 'downloads', labelKey: 'data_section.tabs.downloads', defaultLabel: 'Downloads' },
]

// Demo tab label is hardcoded (DEV-only path) — not in shared locale JSON so
// production never ships seed-related copy.
const DATA_TABS: { id: DataTab; labelKey: string; defaultLabel: string }[] =
  SeedDemoCard != null
    ? [...BASE_DATA_TABS, { id: 'demo', labelKey: '', defaultLabel: 'Demo Data' }]
    : BASE_DATA_TABS

function dataTabId(id: DataTab) {
  return `data-tab-${id}`
}
function dataPanelId(id: DataTab) {
  return `data-panel-${id}`
}

/// `DataSettings` — horizontal tabs (mirrors AI panel layout):
/// 1. Import — restore from backup or another app
/// 2. Export — save journal entries to a file
/// 3. Downloads — opt-in on-device models, offline map, custom fonts
/// 4. Demo Data (DEV only) — seed demo journals/entries
export function DataSettings() {
  const { t } = useTranslation('settings')
  const rawProvider = useSyncStore((s) => s.status?.provider ?? null)
  const provider =
    providerLabel(asCloudProviderKind(rawProvider), t) ||
    t('data_section.local_data_notice_provider_fallback')

  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.dataTab ?? 'import'
  })
  const setActiveTab = (tab: DataTab) => useTabStore.getState().updateActiveTab({ dataTab: tab })
  const slideDir = useTabSlideDirection(
    DATA_TABS.map((tab) => tab.id),
    activeTab,
  )

  // Production (or any build without the demo tab) must not stay on `demo`
  // if a DEV session persisted that selection.
  useEffect(() => {
    const next = coerceDataTab(activeTab)
    if (next !== activeTab) {
      useTabStore.getState().updateActiveTab({ dataTab: next })
    }
  }, [activeTab])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Page title (not sticky) ────────────────────────────────────────── */}
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">{t('categories.data.label')}</h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.data.description')}
        </p>
      </div>

      {/* ── Sticky horizontal tablist ──────────────────────────────────────── */}
      <SettingsTabList
        tabs={DATA_TABS.map((tab) => ({
          id: tab.id,
          // Empty labelKey = DEV-only hardcoded label (no locale entry shipped).
          label: tab.labelKey
            ? t(tab.labelKey, { defaultValue: tab.defaultLabel })
            : tab.defaultLabel,
        }))}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.data')}
        tabId={dataTabId}
        panelId={dataPanelId}
      />

      {/* ── Tabpanels (all mounted; hidden via display) ────────────────────── */}
      <div className="min-h-0 flex-1">
        {DATA_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`data:${tab.id}`}
              id={dataPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={dataTabId(tab.id)}
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
              {tab.id === 'import' && (
                <div className="max-w-180">
                  <ImportModal />
                </div>
              )}

              {tab.id === 'export' && (
                <div className="max-w-180">
                  <ExportModal />
                </div>
              )}

              {tab.id === 'downloads' && (
                <div className="max-w-180">
                  <DownloadsSettings />
                </div>
              )}

              {tab.id === 'demo' && SeedDemoCard != null && (
                <div className="max-w-180">
                  <Suspense fallback={null}>
                    <SeedDemoCard />
                  </Suspense>
                </div>
              )}
            </RestoredScroll>
          )
        })}
      </div>

      {/* ── Page footer: local-data notice (fixed to bottom of Data page) ─── */}
      <div className="border-border-default surface-soft:border-border-default text-fg-muted hover:text-fg flex shrink-0 items-start gap-2 border-t px-2 py-2 text-xs transition-colors">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span className="leading-snug">{t('data_section.local_data_notice', { provider })}</span>
      </div>
    </div>
  )
}
