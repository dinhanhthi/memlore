import { useEffect, useState } from 'react'
import { useEditorDistractionStore } from '../../stores/editorDistractionStore'
import { useActiveView, useSelectedEntryId } from '../../hooks/useActiveTab'
import { useTabStore } from '../../stores/tabStore'
import type { ActiveView } from '../../stores/uiStore'
import { useUiStore } from '../../stores/uiStore'
import {
  EDITOR_FULL_WIDTH_VIEWS,
  isEditorDistractionShellActive,
} from '../../lib/editorDistraction'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { useMediaViewMode } from '../../hooks/useMediaViewMode'
import { Sidebar } from './Sidebar'
import { cn } from '../../lib/cn'
import { EntryList } from './EntryList'
import { EditorPanel } from './EditorPanel'
import { CalendarPanel } from '../calendar/CalendarPanel'
import { SettingsPanel } from '../settings/SettingsPanel'
import { TagsView } from '../tags/TagsView'
import { OnThisDayView } from '../entries/OnThisDayView'
import { MediaGalleryView } from '../media/MediaGalleryView'
import { MediaGalleryFullView } from '../media/MediaGalleryFullView'
import { BODY_OVERLAY_HOST_ID } from '../../lib/overlayHost'
import { LocationsMapView } from '../map/LocationsMapView'
import { StatisticsView } from '../stats/StatisticsView'
import { DailyChatView } from '../chat/DailyChatView'
import { AboutView } from '../about/AboutView'
import { DashboardView } from '../dashboard/DashboardView'

// Secondary-column panels keyed by ActiveView. Views NOT in the map
// (entries) fall through to the EntryList renderer below —
// that's the documented fallback, not an accidental omission.
const SECONDARY_PANELS: Partial<Record<ActiveView, React.ComponentType>> = {
  dashboard: DashboardView,
  calendar: CalendarPanel,
  settings: SettingsPanel,
  tags: TagsView,
  // Real views promoted out of the stubs/ directory.
  onthisday: OnThisDayView,
  media: MediaGalleryView,
  map: LocationsMapView,
  // Chunk E6 stubs — render a "Coming in Phase 5" card until the real feature lands.
  stats: StatisticsView,
  // Phase 6 v2 R9 — Daily Chat occupies the full content area below
  // the sidebar (no entry list; the chat is its own surface).
  chat: DailyChatView,
  about: AboutView,
}

// Views that occupy the full remaining width (secondary + editor columns).
// When active, the secondary column expands and the editor column is hidden.
// `map` is full-width by default; the map view itself renders an overlay
// editor panel that slides in from the right when a pin is clicked.
const FULL_WIDTH_VIEWS = EDITOR_FULL_WIDTH_VIEWS

const DISTRACTION_PANEL_TRANSITION =
  'transition-[width,opacity] duration-(--motion-duration-slow) ease-(--motion-ease-out-expo) motion-reduce:transition-none'

/**
 * Edge-to-edge 3-column shell:
 *
 *   ┌─ Sidebar ─┬─ EntryList / secondary panel ─┬─ Editor ─┐
 *   │  (glass)  │      (glass-subtle)           │  (solid) │
 *   └───────────┴───────────────────────────────┴──────────┘
 *
 * Visual order follows layout_preset via flex-row-reverse (DOM/tab
 * order unchanged). Columns meet at hairline borders — no rounded
 * corners, no gap, no outer padding. The `xj-root` host + TitleBar +
 * FooterBar wrap this component in App.tsx.
 */
export function TwoPanelLayout() {
  const { sidebarRight, panelAfterMain } = useLayoutFlags()
  const activeView = useActiveView()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const selectedEntryId = useSelectedEntryId()
  const mediaViewMode = useMediaViewMode()
  const mediaFullPage = activeView === 'media' && mediaViewMode === 'full'
  const isFullWidth = FULL_WIDTH_VIEWS.has(activeView) || mediaFullPage
  const distractionMode = useEditorDistractionStore((s) => s.distractionMode)
  const setDistractionMode = useEditorDistractionStore((s) => s.setDistractionMode)
  const designSystem = useUiStore((s) => s.designSystem)
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'

  // Full-page media has no editor column — never collapse sidebar over it.
  const editorDistractionActive =
    isEditorDistractionShellActive(distractionMode, selectedEntryId, activeView) && !mediaFullPage

  // Unmount sidebar + entry-list content after the hide animation completes so
  // hidden panels don't keep virtualizing in the background.
  // Remount immediately during render when distraction ends (React-allowed
  // "adjust state when props change"); delay unmount via timeout only.
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const [distractionShellMounted, setDistractionShellMounted] = useState(true)
  const [wasDistractionActive, setWasDistractionActive] = useState(editorDistractionActive)

  if (editorDistractionActive !== wasDistractionActive) {
    setWasDistractionActive(editorDistractionActive)
    if (!editorDistractionActive) {
      setDistractionShellMounted(true)
    }
  }

  useEffect(() => {
    if (!editorDistractionActive) return
    const delay = reducedMotion ? 0 : 400
    const id = window.setTimeout(() => setDistractionShellMounted(false), delay)
    return () => window.clearTimeout(id)
  }, [editorDistractionActive, reducedMotion])

  // Only clear session distraction when the entry is closed — not when
  // navigating to Settings/Stats so focus mode resumes on return.
  useEffect(() => {
    if (distractionMode && selectedEntryId == null) {
      setDistractionMode(false)
    }
  }, [distractionMode, selectedEntryId, setDistractionMode])

  useEffect(() => {
    if (!editorDistractionActive) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[role="dialog"]:not([aria-hidden="true"])')) return
      setDistractionMode(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editorDistractionActive, setDistractionMode])

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const sidebarShellWidth = sidebarCollapsed ? 'w-12' : 'w-36'
  const secondaryShellWidth = 'w-85'
  const distractionPanelHidden = 'w-0 opacity-0 pointer-events-none'

  return (
    <div className={cn('relative flex h-full overflow-hidden')}>
      <div
        className={cn(
          'relative flex h-full min-w-0 flex-1 overflow-hidden',
          sidebarRight && 'flex-row-reverse',
          isClay ? 'bg-chrome' : 'bg-selected-tab',
        )}
      >
        {/* Sidebar column — width-animates in/out of editor distraction mode.
          `overflow-hidden` clips horizontal spill during the w→0 collapse; it also
          traps in-flow popovers, so JournalPicker portals its menu to document.body.
          `h-full` keeps the shell (and Sidebar background) spanning titlebar→footer
          even when the inner aside only sizes to nav content. */}
        <div
          className={cn(
            'relative z-10 flex h-full min-h-0 shrink-0 flex-col overflow-hidden',
            DISTRACTION_PANEL_TRANSITION,
            editorDistractionActive ? distractionPanelHidden : sidebarShellWidth,
          )}
          aria-hidden={editorDistractionActive}
          {...(editorDistractionActive ? { inert: true } : {})}
        >
          {distractionShellMounted && <Sidebar />}
        </div>

        {/* Content area — the .xj-content-gradient host is padded (p-2 +
          pl-0/pr-0 toward the sidebar), so the gradient is only visible as
          the thin gutter framing the rounded card below. The card itself is
          opaque (bg-elevated) and is the fallback surface for any column that
          doesn't paint its own background. In editor distraction mode the
          sidebar is gone, so the flush padding is restored to keep the gutter
          even on all four sides. */}
        <div
          className={cn(
            'z-30 flex min-w-0 flex-1',
            !isClean && 'p-2',
            !editorDistractionActive && !isClean && !isClay && (sidebarRight ? 'pr-0' : 'pl-0'),
          )}
        >
          {/* `id` marks this card as the measure target for body-scoped overlays
            (Modal / Search / SlideOver / editor carousel). Dialogs portal to
            document.body but pin a fixed layer to this card's box. */}
          <div
            id={BODY_OVERLAY_HOST_ID}
            className={cn(
              'relative flex h-full w-full',
              panelAfterMain && 'flex-row-reverse',
              isClay ? 'gap-2 overflow-visible' : 'overflow-hidden',
              !isClean &&
                !isClay &&
                cn(
                  'border-elevated bg-elevated rounded-2xl border dark:border-none',
                  sidebarRight ? 'border-l-border-default' : 'border-r-border-default',
                ),
            )}
          >
            {/* Secondary column — EntryList or one of the panel views.
            The shell class here resolves to transparent, so full-width canvases
            (settings/stats/chat/map/about per EDITOR_FULL_WIDTH_VIEWS, plus media
            in full-page mode) inherit the card's bg-elevated surface wherever
            their own content is transparent. The "first panel" views (entries, memories,
            calendar, tags, and the chat/settings left rails) paint their own
            opaque `bg-panel-2` on top so every page's first panel reads as the
            same elevated-rail surface. Settings manages its own internal split;
            stats/map/about render a single main panel. */}
            <div
              className={cn(
                'flex shrink-0 flex-col',
                isClay
                  ? 'overflow-visible bg-transparent'
                  : 'bg-panel-3 overflow-hidden dark:bg-transparent',
                !isFullWidth && DISTRACTION_PANEL_TRANSITION,
                isFullWidth
                  ? 'flex-1'
                  : editorDistractionActive
                    ? distractionPanelHidden
                    : secondaryShellWidth,
              )}
              aria-hidden={editorDistractionActive}
              {...(editorDistractionActive ? { inert: true } : {})}
            >
              {distractionShellMounted &&
                (() => {
                  // Media full-page replaces the 2-panel gallery; map stays static.
                  if (activeView === 'media') {
                    const Panel = mediaFullPage ? MediaGalleryFullView : MediaGalleryView
                    return <Panel key={activeTabId} />
                  }
                  const Panel = SECONDARY_PANELS[activeView]
                  return Panel ? <Panel key={activeTabId} /> : <EntryList key={activeTabId} />
                })()}
            </div>

            {/* Editor column — hidden for full-width views like settings.
            A thin hairline separates it from the entry list (border-l, or
            border-r when panelAfterMain). */}
            {!isFullWidth && (
              <div
                className={cn(
                  'min-w-0 flex-1 overflow-hidden transition-[border-color] duration-(--motion-duration-slow) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
                  isClay
                    ? 'xj-main-panel bg-elevated rounded-2xl shadow-(--shadow-panel)'
                    : cn(
                        !editorDistractionActive &&
                          !isClean &&
                          (panelAfterMain
                            ? 'border-elevated border-r'
                            : 'border-elevated border-l'),
                        // Light: solid white editor surface so the right panel reads white
                        // instead of the content gradient's faint lavender. Dark: stay
                        // transparent so the seamless content gradient shows as before.
                        'bg-panel-3 dark:bg-transparent',
                      ),
                )}
              >
                <EditorPanel entryId={selectedEntryId} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
