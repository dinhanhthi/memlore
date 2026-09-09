import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, History, LineChart, Lightbulb, Sparkles, type LucideIcon } from 'lucide-react'
import { RestoredScroll } from '../common/RestoredScroll'
import { SegmentedControl } from '../common/SegmentedControl'
import { cn } from '../../lib/cn'
import { useTabStore } from '../../stores/tabStore'
import { type StatsTab, useUiStore } from '../../stores/uiStore'
import { ChartCard } from './ChartCard'
import { ChartsGate } from './ChartsGate'
import ChartsSkeleton from './ChartsSkeleton'
import { PeriodSelector, type Period } from './PeriodSelector'
import { AiAuditLogPanel } from './AiAuditLogPanel'
import { AiUsagePanel } from './AiUsagePanel'
import { InsightsPanel } from './InsightsPanel'
import { PeriodReviewView } from '../ai/PeriodReviewView'
import { ExportButton } from './ExportButton'
import { SyncCatchupBanner } from '../common/SyncCatchupBanner'

const EntriesOverTimeChart = lazy(() =>
  import('./EntriesOverTimeChart').then((m) => ({ default: m.EntriesOverTimeChart })),
)
const EmotionHistogram = lazy(() =>
  import('./EmotionHistogram').then((m) => ({ default: m.EmotionHistogram })),
)
const WritingVolumeChart = lazy(() =>
  import('./WritingVolumeChart').then((m) => ({ default: m.WritingVolumeChart })),
)
const WordCountBox = lazy(() => import('./WordCountBox').then((m) => ({ default: m.WordCountBox })))
const TagCloud = lazy(() => import('./TagCloud').then((m) => ({ default: m.TagCloud })))
const StreakCalendar = lazy(() =>
  import('./StreakCalendar').then((m) => ({ default: m.StreakCalendar })),
)
const EmotionHeatmap = lazy(() =>
  import('./EmotionHeatmap').then((m) => ({ default: m.EmotionHeatmap })),
)
const LocationHeatmap = lazy(() =>
  import('./LocationHeatmap').then((m) => ({ default: m.LocationHeatmap })),
)

// ─── Tab IDs ─────────────────────────────────────────────────────────────────

const STATS_TABS: { id: StatsTab; labelKey: string; defaultLabel: string; icon: LucideIcon }[] = [
  { id: 'charts', labelKey: 'tabs.charts', defaultLabel: 'Charts', icon: LineChart },
  { id: 'insights', labelKey: 'tabs.insights', defaultLabel: 'Insights', icon: Lightbulb },
  { id: 'reviews', labelKey: 'tabs.reviews', defaultLabel: 'Reviews', icon: Sparkles },
  { id: 'usage', labelKey: 'tabs.usage', defaultLabel: 'AI usage', icon: BarChart3 },
  { id: 'audit', labelKey: 'tabs.audit', defaultLabel: 'AI audit log', icon: History },
]

function statsTabId(id: StatsTab) {
  return `stats-tab-${id}`
}
function statsPanelId(id: StatsTab) {
  return `stats-panel-${id}`
}

/**
 * Statistics view — main panel rendered when the user clicks the Stats
 * sidebar item.
 *
 * Three horizontal tabs:
 *   1. Charts   — entry / mood / tag / streak / heatmap visualizations
 *   2. AI usage — token / call counts per provider (moved from Settings → AI)
 *   3. AI audit — per-request metadata log (moved from Settings → AI)
 *
 * The Charts tab keeps the prior 2-column layout. AI tabs reuse the
 * existing `AiUsagePanel` / `AiAuditLogPanel` components verbatim —
 * they live under `components/settings/` for historical reasons but
 * are observability surfaces that fit better in Statistics.
 */
export function StatisticsView() {
  const { t } = useTranslation('stats')
  const isClay = useUiStore((s) => s.designSystem) === 'clay'
  const [period, setPeriod] = useState<Period>('30d')
  // Per-app-tab so each stats view keeps its own sub-tab independently.
  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.statsTab ?? 'charts'
  })
  const setActiveTab = (tab: StatsTab) => useTabStore.getState().updateActiveTab({ statsTab: tab })

  // Track which tabs have been visited this mount. Panel content only mounts
  // for the active tab and tabs the user has already opened — never for a
  // never-visited tab. This preserves scroll position / loaded data across
  // tab switches (visited panels stay mounted) while avoiding a 0×0-container
  // crash in size-sensitive children like `LocationHeatmap`'s Leaflet map when
  // a non-default `statsTab` is persisted and the Charts panel would otherwise
  // mount hidden (display:none → canvas getImageData IndexSizeError).
  const [visitedTabs, setVisitedTabs] = useState<Set<StatsTab>>(() => new Set([activeTab]))
  if (!visitedTabs.has(activeTab)) {
    setVisitedTabs(new Set(visitedTabs).add(activeTab))
  }

  return (
    <div
      data-testid="statistics-view"
      className={cn(
        '@container flex h-full flex-col overflow-hidden',
        isClay && 'xj-main-panel bg-selected-tab rounded-2xl shadow-(--shadow-panel)',
      )}
    >
      {/* ── Page title + Export button (not sticky) ────────────────────────── */}
      <div className="flex shrink-0 items-start justify-between gap-4 p-4">
        <div className="min-w-0">
          <h1 className="font-title text-fg text-2xl font-extrabold">
            {t('page.title', { defaultValue: 'Statistics' })}
          </h1>
          <p className="text-fg-muted mt-1 text-sm">
            {t('page.description', {
              defaultValue:
                'Visualize your journaling patterns and review AI activity across your entries.',
            })}
          </p>
        </div>
        <div className="shrink-0">
          <ExportButton />
        </div>
      </div>

      {/* ── Section picker — Clay segmented control (ids feed the panels'
       *    aria-labelledby via statsTabId). Arrow keys commit like tabs did. */}
      <div className="shrink-0 px-4 pb-3">
        <SegmentedControl
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel={t('tab_sections.statistics')}
          idPrefix="stats-tab"
          commitOnArrow
          options={STATS_TABS.map((tab) => {
            const label = t(tab.labelKey, { defaultValue: tab.defaultLabel })
            const Icon = tab.icon
            return {
              value: tab.id,
              ariaLabel: label,
              label: (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate whitespace-nowrap @max-[640px]:hidden">{label}</span>
                </span>
              ),
            }
          })}
        />
      </div>

      {/* ── Tabpanels (visited tabs mounted; hidden via display) ─────────────
       *
       * Panel content mounts only for the active tab and tabs the user has
       * already visited this session, then stays mounted (hidden via
       * `display: none`) so per-tab scroll position and loaded chart data
       * survive tab switches. `inert` + `aria-hidden` keep keyboard focus
       * and screen readers out of the hidden subtree.
       *
       * The deferral is required for size-sensitive children: Leaflet maps
       * (LocationHeatmap) crash with `IndexSizeError` when initialized in a
       * 0×0 container, which happens when a non-default `statsTab` is
       * persisted and the Charts panel would otherwise mount hidden.
       *
       * The `audit` panel uses `overflow-hidden` (not `overflow-y-auto`)
       * so its inner table can own the scrollbar while the top controls
       * (privacy note, retention, clear, filters) stay pinned. Other
       * tabs scroll the whole panel as usual. */}
      <div className="min-h-0 flex-1">
        {STATS_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          const shouldRender = isActive || visitedTabs.has(tab.id)
          const ownsScroll = tab.id !== 'audit'
          return (
            <RestoredScroll
              key={tab.id}
              view="stats"
              sub={tab.id}
              id={statsPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={statsTabId(tab.id)}
              aria-hidden={!isActive}
              inert={!isActive}
              tabIndex={0}
              style={{ display: isActive ? 'block' : 'none' }}
              className={cn(
                'h-full outline-none',
                ownsScroll ? 'overflow-y-auto' : 'overflow-hidden',
              )}
            >
              {shouldRender && tab.id === 'charts' && (
                <div className="flex flex-col gap-4 p-5">
                  {/* One skeleton, one swap: `ChartsGate` holds the skeleton
                      until the chart data is cached, then the lazy chunks
                      resolve behind the identical Suspense fallback. */}
                  <Suspense fallback={<ChartsSkeleton />}>
                    <ChartsGate period={period}>
                      {/* 2-column grid */}
                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {/* Column 1 */}
                        <div className="flex flex-col gap-4">
                          <ChartCard
                            title={t('chart.entries_over_time.title')}
                            exportName="entries-over-time"
                            action={<PeriodSelector value={period} onChange={setPeriod} />}
                          >
                            <EntriesOverTimeChart period={period} />
                          </ChartCard>

                          <ChartCard
                            title={t('chart.writing_volume.title')}
                            exportName="writing-volume"
                          >
                            <WritingVolumeChart period={period} />
                          </ChartCard>
                        </div>

                        {/* Column 2 */}
                        <div className="flex flex-col gap-4">
                          <ChartCard
                            title={t('chart.word_count.title')}
                            action={<PeriodSelector value={period} onChange={setPeriod} />}
                          >
                            <WordCountBox period={period} />
                          </ChartCard>

                          <ChartCard title={t('chart.mood_trend.title')} exportName="mood-trend">
                            <EmotionHistogram period={period} />
                          </ChartCard>

                          <ChartCard
                            title={t('chart.tag_frequency.title')}
                            exportName="tag-frequency"
                            exportRaster
                          >
                            <TagCloud />
                          </ChartCard>
                        </div>
                      </div>

                      <ChartCard
                        title={t('chart.streak_calendar.title')}
                        exportName="streak-calendar"
                      >
                        <StreakCalendar />
                      </ChartCard>

                      <ChartCard
                        title={t('chart.emotion_heatmap.title')}
                        exportName="emotion-heatmap"
                      >
                        <EmotionHeatmap />
                      </ChartCard>

                      <ChartCard
                        title={t('chart.location_heatmap.title')}
                        exportName="location-heatmap"
                        exportRaster
                      >
                        <LocationHeatmap />
                      </ChartCard>
                    </ChartsGate>
                  </Suspense>
                </div>
              )}

              {shouldRender && tab.id === 'insights' && (
                <div className="p-5">
                  <InsightsPanel />
                </div>
              )}

              {shouldRender && tab.id === 'reviews' && (
                <div className="p-5">
                  <PeriodReviewView />
                </div>
              )}

              {shouldRender && tab.id === 'usage' && (
                <div className="p-5">
                  <AiUsagePanel />
                </div>
              )}

              {shouldRender && tab.id === 'audit' && (
                <div className="flex h-full flex-col p-5">
                  <div className="flex min-h-0 w-full flex-1 flex-col">
                    <AiAuditLogPanel />
                  </div>
                </div>
              )}
            </RestoredScroll>
          )
        })}
      </div>

      <footer className="shrink-0 empty:hidden">
        <SyncCatchupBanner />
      </footer>
    </div>
  )
}
