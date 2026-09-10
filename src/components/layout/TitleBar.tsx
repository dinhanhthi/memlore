import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLogoDirection, logoSrc, ALL_LOGO_DIRECTIONS } from '../../hooks/useLogoDirection'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDesignSystem } from '../../hooks/useDesignSystem'
import { useTheme } from '../../hooks/useTheme'
import { cn } from '../../lib/cn'
import { titlebarRowHeight } from '../../lib/windowChrome'
import { SIDEBAR_VIEW_ICONS } from '../../lib/viewIcons'
import { useEntryStore } from '../../stores/entryStore'
import { useJournalStore } from '../../stores/journalStore'
import type { Tab } from '../../stores/tabStore'
import { useTabStore } from '../../stores/tabStore'
import { useUiStore, type ActiveView } from '../../stores/uiStore'
import { useChatSessionStore } from '../../stores/chatSessionStore'
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Settings,
  Moon,
  Sun,
  Command,
  X,
} from 'lucide-react'
import { IconCustom } from '../common/IconCustom'
import { Tooltip } from '../common/Tooltip'
import { JournalAllIcon } from '../journals/JournalAllIcon'
import { TabContextMenu } from './TabContextMenu'
import { emitEntriesChanged } from '../../hooks/useEntries'
import { emitJournalsChanged } from '../../hooks/useJournals'
import { emitTagsChanged } from '../../hooks/useTags'
import { emitMediaChanged } from '../../lib/mediaEvents'

// Lock drag translation to the X axis so tabs slide horizontally only.
// Inlined (instead of pulling in @dnd-kit/modifiers) because the modifier
// API is just `(args) => transform` — the package is barely more code.
const restrictToHorizontalAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 })

// True when running in a plain browser (web mock) — no native traffic lights.
const isWebMock = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)

// Module-scope i18n key map per ActiveView. Using a map (not inline lookups)
// keeps the TypeScript exhaustiveness check — adding a new ActiveView variant
// without updating this map is a compile error.
const VIEW_LABEL_KEYS: Record<ActiveView, string> = {
  dashboard: 'dashboard',
  entries: 'entries',
  tags: 'tags',
  calendar: 'calendar',
  search: 'search',
  settings: 'settings',
  onthisday: 'onthisday',
  media: 'media',
  map: 'map',
  stats: 'stats',
  chat: 'chat',
  about: 'about',
}

/**
 * Start a window drag when the user mouses down on empty titlebar space.
 * WKWebView (Tauri's macOS renderer) does NOT honor `data-tauri-drag-region`
 * or the `-webkit-app-region: drag` CSS property reliably. The supported
 * approach is calling `startDragging()` from `@tauri-apps/api/window` —
 * see docs/plans/redesign/chunk-d-shell-visuals.md and the reference note
 * at learn-with-ai/Mobile_Dev/tauri-desktop-app-gotchas.md.
 *
 * Requires the `core:window:allow-start-dragging` permission in
 * `src-tauri/capabilities/default.json`.
 */
function handleTitleBarMouseDown(e: React.MouseEvent) {
  const target = e.target as HTMLElement
  // Skip interactive children so clicks still fire normally.
  if (target.closest('a, button, input, select, textarea, [role="button"]')) {
    return
  }
  // In production the rejection is silently swallowed — drag just no-ops if
  // the capability permission is misconfigured. In dev we warn once so a
  // broken `core:window:allow-start-dragging` grant isn't invisible to
  // whoever is adding the feature.
  void getCurrentWindow()
    .startDragging()
    .catch((err: unknown) => {
      if (import.meta.env.DEV) {
        console.warn('[TitleBar] startDragging() rejected:', err)
      }
    })
}

// ── Hook: track tab strip overflow to show/hide scroll arrows ──

function useTabBarOverflow(scrollRef: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const update = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [scrollRef])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    update()
    el.addEventListener('scroll', update, { passive: true })

    const ro = new ResizeObserver(update)
    ro.observe(el)

    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps])

  return { canScrollLeft, canScrollRight }
}

/**
 * TitleBar — the macOS overlay titlebar row.
 *
 * Layout contract:
 * - `titleBarStyle: "Overlay"` (tauri.conf.json) → NATIVE traffic-light
 *   buttons remain (we do NOT render fake ones). The row height comes from
 *   `titlebarRowHeight(designSystem)`; `useTitlebarRowHeightSync` reports it to the
 *   Rust side, which vertically centres the native cluster in that row.
 * - `pl-22.5` carves out horizontal space for those native dots so tab
 *   buttons don't overlap them.
 * - `data-tauri-drag-region` makes empty areas drag the window; the
 *   interactive children (buttons, tabs) stop propagation natively.
 *
 * Contents (merged from the old TitleBar + TabStrip split):
 *   [padding]  [tab strip]  [right-side action cluster]
 *                          (+ · search · settings · theme · command)
 */
export function TitleBar() {
  const { t } = useTranslation('nav')
  const {
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    newTab,
    reorderTab,
    duplicateTab,
    togglePinTab,
  } = useTabStore()
  // Tab right-click menu state — null when no menu is open.
  const [contextMenu, setContextMenu] = useState<{
    tabId: string
    anchor: { x: number; y: number }
  } | null>(null)
  const toggleSearchOverlay = useUiStore((s) => s.toggleSearchOverlay)
  const { theme, toggleTheme } = useTheme()
  const { lightAllowed, designSystem } = useDesignSystem()
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'

  const scrollRef = useRef<HTMLDivElement>(null)
  const { canScrollLeft, canScrollRight } = useTabBarOverflow(scrollRef, [tabs.length])

  // Scroll active tab fully into view when activeTabId changes.
  useEffect(() => {
    const container = scrollRef.current
    if (!activeTabId || !container) return
    const tab = container.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null
    if (!tab) return
    // Use getBoundingClientRect so positions are in the same coordinate space
    // regardless of offsetParent chains.
    const containerRect = container.getBoundingClientRect()
    const tabRect = tab.getBoundingClientRect()
    const GAP = 4 // a few px breathing room so the tab isn't flush with the edge
    if (tabRect.left < containerRect.left) {
      container.scrollBy({ left: tabRect.left - containerRect.left - GAP, behavior: 'smooth' })
    } else if (tabRect.right > containerRect.right) {
      container.scrollBy({ left: tabRect.right - containerRect.right + GAP, behavior: 'smooth' })
    }
  }, [activeTabId])

  function scrollTabs(direction: 'left' | 'right') {
    const el = scrollRef.current
    if (!el) return
    const reducedMotion =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
    const amount = el.clientWidth * 0.6 * (direction === 'left' ? -1 : 1)
    el.scrollBy({ left: amount, behavior: reducedMotion ? 'auto' : 'smooth' })
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (e.shiftKey && e.deltaY !== 0) {
      e.currentTarget.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }

  // Require a small pointer movement before drag starts so plain clicks
  // (select tab, click close ×) keep working unchanged. 6px matches the
  // click-tolerance convention macOS browsers use (~5px in Safari/Chrome) —
  // keep it in that ballpark so accidental drags from tiny mouse jitter
  // don't fire.
  // KeyboardSensor + sortableKeyboardCoordinates enables Space/Enter to
  // pick a tab up and arrow keys to move it, matching the a11y affordance
  // that dnd-kit announces via its sortable live region.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs])

  // Track the dragged tab so we can render a `<DragOverlay>` clone. Without
  // an overlay, the source tab gets `transform: translate3d(...)` applied
  // and the surrounding flex layout recomputes widths every reorder swap,
  // which makes the title text "deform" (re-truncate) mid-drag.
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const activeDragTab = activeDragId ? (tabs.find((t) => t.id === activeDragId) ?? null) : null

  function handleDragStart(event: DragStartEvent) {
    if (typeof event.active.id !== 'string') return
    setActiveDragId(event.active.id)
  }

  function handleDragCancel() {
    setActiveDragId(null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    // Tab ids are crypto.randomUUID() strings, but dnd-kit types ids as
    // `string | number`. Bail out instead of coercing — keeps the contract
    // with the store strict.
    if (typeof active.id !== 'string') return
    const toIndex = tabs.findIndex((t) => t.id === over.id)
    if (toIndex === -1) return
    reorderTab(active.id, toIndex)
  }

  return (
    <div
      onMouseDown={handleTitleBarMouseDown}
      className={cn(
        'bg-chrome relative z-40 flex shrink-0 items-center gap-3 pr-2.5',
        isWebMock ? 'pl-4' : 'pl-22.5',
        isClean && 'border-border-default border-b',
      )}
      style={{
        // Row height per skin; the Rust side re-centres the macOS traffic
        // lights on it (see `useTitlebarRowHeightSync` → `set_titlebar_row_height`).
        height: titlebarRowHeight(designSystem),
      }}
    >
      {/* Mock macOS traffic-light dots — web preview only, not shown in real Tauri app */}
      {isWebMock && <MockTrafficLights />}

      {/* App logo only — sits right of traffic lights, left of tab strip */}
      <div className="ml-1 flex shrink-0 items-center">
        <TitleBarLogo />
      </div>

      {/* Tab strip — DndContext wraps the scroll container so dnd-kit's
       *  auto-scroll detects the strip as the scrollable ancestor of the
       *  dragged tab. The dragged tab is rendered via <DragOverlay/> (a
       *  portal-style floating clone tied to the pointer); the source tab
       *  in the strip stays in place with `visibility: hidden`. This avoids
       *  the title-text "re-truncating" mid-drag that happens when the
       *  source tab is translated and the surrounding flex layout
       *  recomputes widths. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div
            ref={scrollRef}
            data-testid="tab-scroll-container"
            className={cn(
              'no-scrollbar flex min-h-0 min-w-0 flex-1 self-stretch overflow-x-auto',
              isClay ? 'items-center gap-1' : 'items-stretch gap-0',
            )}
            onWheel={handleWheel}
          >
            {/* Flex spacers (not padding): outer ears of the first/last active
                tab paint over these so overflow-x does not clip them. */}
            <span aria-hidden className="xj-tab-strip-end-space" />
            {tabs.map((tab) => (
              <WindowTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                canClose={tabs.length > 1}
                onSelect={() => setActiveTab(tab.id)}
                onClose={() => closeTab(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ tabId: tab.id, anchor: { x: e.clientX, y: e.clientY } })
                }}
              />
            ))}
            <span aria-hidden className="xj-tab-strip-end-space" />
          </div>
        </SortableContext>
        <DragOverlay
          // No drop animation — once released, the overlay disappears and
          // the source tab (now in its new slot) becomes visible. A drop
          // animation would briefly show the overlay tweening to the old
          // slot before the swap, which reads wrong.
          dropAnimation={null}
        >
          {activeDragTab ? (
            <WindowTabPresentation
              tab={activeDragTab}
              active={activeDragTab.id === activeTabId}
              canClose={tabs.length > 1}
              isOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Right-side action cluster */}
      <div className="flex shrink-0 items-center gap-1">
        <TabScrollArrow
          direction="left"
          disabled={!canScrollLeft}
          onClick={() => scrollTabs('left')}
        />
        <TabScrollArrow
          direction="right"
          disabled={!canScrollRight}
          onClick={() => scrollTabs('right')}
          className="mr-1.5"
        />
        <TitleBarAction
          ariaLabel={t('titlebar.new_tab')}
          tooltip={t('titlebar.new_tab_tooltip')}
          onClick={() => newTab()}
          icon={<Plus className="size-3.5" strokeWidth={1.75} />}
        />
        <TitleBarAction
          ariaLabel={t('titlebar.search')}
          tooltip={t('titlebar.search_tooltip')}
          onClick={toggleSearchOverlay}
          icon={<Search className="size-3.5" strokeWidth={1.75} />}
        />
        <TitleBarAction
          ariaLabel={t('titlebar.settings')}
          tooltip={t('titlebar.settings_tooltip')}
          onClick={() =>
            useTabStore
              .getState()
              .updateActiveTab({ activeView: 'settings', selectedEntryId: null })
          }
          icon={<Settings className="size-3.5" strokeWidth={1.75} />}
        />
        {lightAllowed && (
          <TitleBarAction
            ariaLabel={t('titlebar.toggle_theme')}
            tooltip={t(
              theme === 'light' ? 'titlebar.toggle_theme_light' : 'titlebar.toggle_theme_dark',
            )}
            onClick={toggleTheme}
            icon={
              theme === 'light' ? (
                <Moon className="size-3.5" strokeWidth={1.75} />
              ) : (
                <Sun className="size-3.5" strokeWidth={1.75} />
              )
            }
          />
        )}
        <TitleBarAction
          ariaLabel={t('titlebar.command_palette')}
          tooltip={t('titlebar.command_palette_tooltip')}
          onClick={() => useUiStore.getState().setCommandPaletteOpen(true)}
          icon={<Command className="size-3.5" strokeWidth={1.75} />}
        />
      </div>

      {contextMenu &&
        (() => {
          // Re-resolve the target tab inside the IIFE so the menu always
          // mirrors the latest store state — e.g. another `togglePin`
          // happening in the same render pass would otherwise show stale
          // "Pin" copy. Closing here is safer than a stale-id render.
          const target = tabs.find((tab) => tab.id === contextMenu.tabId)
          if (!target) return null
          return (
            <TabContextMenu
              isOnlyTab={tabs.length <= 1}
              isPinned={target.pinned === true}
              anchor={contextMenu.anchor}
              onClose={() => setContextMenu(null)}
              onDuplicate={() => duplicateTab(target.id)}
              onCloseTab={() => closeTab(target.id)}
              onTogglePin={() => togglePinTab(target.id)}
              onRefresh={() => {
                // Refresh = refetch the data feeding the active tab's
                // view. App is single-window single-page, so we don't
                // (and shouldn't) call window.location.reload() — that
                // would nuke every tab's state. Fire the four broad
                // change signals; each one is already wired through
                // React Query invalidation by the mutation flows. This
                // covers entries / tags / journals / media
                // / calendar / stats / search views. Locations resolve
                // from entry rows, so they ride along on
                // `entries-changed`.
                emitEntriesChanged()
                emitJournalsChanged()
                emitTagsChanged()
                emitMediaChanged()
              }}
            />
          )
        })()}
    </div>
  )
}

// ── Scroll arrow button ──

interface TabScrollArrowProps {
  direction: 'left' | 'right'
  disabled: boolean
  onClick: () => void
  className?: string
}

function TabScrollArrow({ direction, disabled, onClick, className }: TabScrollArrowProps) {
  const { t } = useTranslation('nav')
  const label =
    direction === 'left' ? t('titlebar.scroll_tabs_left') : t('titlebar.scroll_tabs_right')

  return (
    <Tooltip content={label} placement="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'text-fg-muted hover:bg-surface-hi hover:text-fg grid h-7 w-6 shrink-0 cursor-pointer place-items-center rounded-lg border-none bg-transparent transition-[background-color,color] duration-(--motion-duration-fast) disabled:cursor-default disabled:opacity-50',
          className,
        )}
      >
        {direction === 'left' ? (
          <ChevronLeft className="size-3" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="size-3" strokeWidth={1.75} />
        )}
      </button>
    </Tooltip>
  )
}

// ── Single tab ──

interface WindowTabProps {
  tab: Tab
  active: boolean
  canClose: boolean
  onSelect: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function WindowTab({ tab, active, canClose, onSelect, onClose, onContextMenu }: WindowTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  })

  return (
    <WindowTabPresentation
      tab={tab}
      active={active}
      canClose={canClose}
      onSelect={onSelect}
      onClose={onClose}
      onContextMenu={onContextMenu}
      sortableRef={setNodeRef}
      sortableStyle={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Hide (not opacity 0) so the source slot still reserves its size
        // in the flex layout and neighbors don't reflow. The DragOverlay
        // renders the visible clone tied to the pointer.
        visibility: isDragging ? 'hidden' : undefined,
      }}
      sortableAttributes={attributes}
      sortableListeners={listeners as Record<string, (event: React.SyntheticEvent) => void>}
      isDragging={isDragging}
    />
  )
}

interface WindowTabPresentationProps {
  tab: Tab
  active: boolean
  canClose: boolean
  onSelect?: () => void
  onClose?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** Sortable wiring — supplied by `WindowTab`, omitted by the overlay clone. */
  sortableRef?: (node: HTMLElement | null) => void
  sortableStyle?: React.CSSProperties
  sortableAttributes?: React.HTMLAttributes<HTMLElement>
  sortableListeners?: Record<string, (event: React.SyntheticEvent) => void>
  isDragging?: boolean
  /** True when rendered inside `<DragOverlay/>` — disables interactive
   *  handlers (click/close) and adds a slight shadow so the floating clone
   *  reads as "picked up". */
  isOverlay?: boolean
}

function WindowTabPresentation({
  tab,
  active,
  canClose,
  onSelect,
  onClose,
  onContextMenu,
  sortableRef,
  sortableStyle,
  sortableAttributes,
  sortableListeners,
  isDragging,
  isOverlay,
}: WindowTabPresentationProps) {
  const { t } = useTranslation('nav')
  const designSystem = useUiStore((s) => s.designSystem)
  const isClay = designSystem === 'clay'
  const title = useTabTitle(tab)
  // Resolve the journal-circle icon from the entry the tab has open —
  // not the tab's journal-picker scope (`tab.journalId`). Opening an
  // entry in-place (search, calendar, on-this-day, map, etc.) only
  // patches `selectedEntryId` and leaves `journalId` untouched, so
  // using `tab.journalId` here would show the wrong color for entries
  // from other journals. Falls back to `tab.journalId` when no entry
  // is selected (e.g. an empty journal tab). Mirrors `useTabTitle`'s
  // use of the persistent `entriesById` map so it resolves for
  // inactive tabs too.
  const journal = useTabJournal(tab)
  const pinned = tab.pinned === true
  const SidebarIcon = SIDEBAR_VIEW_ICONS[tab.activeView]

  const button = (
    <button
      ref={sortableRef}
      style={{
        // Overlay clone has no titlebar parent — pin explicit row height.
        // Clay tabs are inset pills (`h-9`), not flush to the titlebar.
        ...(isOverlay && !isClay ? { height: titlebarRowHeight(designSystem) } : null),
        ...sortableStyle,
      }}
      {...sortableAttributes}
      {...sortableListeners}
      type="button"
      aria-label={t('titlebar.tab', { id: tab.id })}
      aria-selected={active}
      aria-haspopup="menu"
      data-tab-id={tab.id}
      onClick={isOverlay ? undefined : onSelect}
      onContextMenu={isOverlay ? undefined : onContextMenu}
      onMouseDown={(e) => {
        if (isOverlay) return
        // Middle-click closes — but never a pinned tab. Pinned tabs require
        // an explicit Unpin → Close flow (same as Chrome/Arc) so users
        // don't lose a pinned tab to a misclick.
        if (e.button === 1 && canClose && !pinned && onClose) {
          e.preventDefault()
          onClose()
        }
      }}
      className={cn(
        'group relative inline-flex shrink-0 items-center gap-2 select-none',
        'transition-[background-color,color] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
        // Pinned tabs collapse to a fixed icon-only width and lose the
        // text padding. Unpinned tabs keep the existing flexible width.
        pinned ? 'w-9 justify-center px-0' : 'max-w-60 min-w-30 pr-2',
        isDragging || isOverlay ? 'cursor-grabbing' : 'cursor-pointer',
        pinned ? '' : 'pl-3',
        isClay
          ? cn(
              'h-9 rounded-lg',
              active || isOverlay
                ? 'xj-nav-active text-fg bg-(--nav-active-bg)'
                : 'text-fg-muted hover:bg-surface-hi hover:text-fg bg-transparent',
            )
          : cn(
              // SuperX titlebar tabs: flush; active has outward bottom ears.
              'h-full rounded-none py-0',
              isOverlay
                ? 'bg-elevated border-border-default text-fg border shadow-(--elev-2)'
                : active
                  ? 'bg-selected-tab text-fg'
                  : 'text-fg-muted hover:bg-surface-hi hover:text-fg bg-transparent',
            ),
      )}
    >
      {/* Active: top accent + outward chrome-corner ears (panel-2 cutaway tips). */}
      {active && !isOverlay && !isClay && (
        <>
          <span
            aria-hidden
            className="bg-accent absolute inset-x-0 top-0 z-1 h-0.5 rounded-t-2xl"
          />
          <span aria-hidden className="xj-tab-chrome-corner xj-tab-chrome-corner-left" />
          <span aria-hidden className="xj-tab-chrome-corner xj-tab-chrome-corner-right" />
        </>
      )}
      {SidebarIcon ? (
        <SidebarIcon
          className={cn('size-3.5 shrink-0', active ? 'text-accent' : 'text-fg-muted')}
          strokeWidth={2.25}
        />
      ) : journal !== null ? (
        <span
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 rounded-full', pinned ? '' : 'ml-1')}
          style={{ background: journal.color ?? 'var(--color-accent)' }}
        />
      ) : (
        <JournalAllIcon className="size-3.5 shrink-0" />
      )}

      {/* Title — hidden when pinned (icon-only). */}
      {!pinned && (
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{title}</span>
      )}

      {/* Close × (fades in on hover/active). Skipped on pinned tabs (must
       *  unpin first via context menu) and on the overlay clone. */}
      {canClose && !isOverlay && !pinned && (
        <span
          role="button"
          aria-label={t('titlebar.close_tab', { id: tab.id })}
          onPointerDown={(e) => {
            // Stop dnd-kit's PointerSensor on the parent tab button from
            // arming a drag when the user is reaching for ×.
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onClose?.()
          }}
          className={cn(
            'text-fg-muted hover:text-fg inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent',
            {
              'opacity-0 group-hover:opacity-100': !active,
              'opacity-100': active,
            },
          )}
        >
          <X className="size-3" strokeWidth={1.75} />
        </span>
      )}
    </button>
  )

  // Pinned tabs lose the inline title, so surface it via tooltip on hover.
  // Skip the tooltip on the drag overlay clone — it's a non-interactive
  // floating ghost and a tooltip there reads as a stray label. While a
  // drag is in flight we pass `disabled` so the popover stays hidden;
  // we do NOT conditionally render `<Tooltip>` away because that would
  // unmount the wrapper span mid-drag and rip the button DOM node out
  // from under `useSortable`'s captured ref, which can silently abort
  // the active drag.
  if (pinned && !isOverlay) {
    return (
      <Tooltip content={title} placement="bottom" disabled={isDragging === true}>
        {button}
      </Tooltip>
    )
  }
  return button
}

// ── Mock macOS traffic-light buttons (web preview only) ──

function MockTrafficLights() {
  return (
    <div aria-hidden="true" className="mr-1 flex shrink-0 items-center gap-2">
      <span className="size-3 rounded-full" style={{ backgroundColor: '#FF5F57' }} />
      <span className="size-3 rounded-full" style={{ backgroundColor: '#FEBC2E' }} />
      <span className="size-3 rounded-full" style={{ backgroundColor: '#28C840' }} />
    </div>
  )
}

// ── Right-side icon action ──

interface ActionProps {
  ariaLabel: string
  onClick: () => void
  icon: React.ReactNode
  tooltip?: string
}

function TitleBarAction({ ariaLabel, onClick, icon, tooltip }: ActionProps) {
  const btn = (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      // SuperX icon button: 10px radius, transparent idle, surface-hi hover.
      className="text-fg-muted hover:bg-surface-hi hover:text-fg grid h-7 w-7 cursor-pointer place-items-center rounded-lg border-none bg-transparent transition-[background-color,color] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)"
    >
      {icon}
    </button>
  )

  if (!tooltip) return btn

  return (
    <Tooltip content={tooltip} placement="bottom">
      {btn}
    </Tooltip>
  )
}

// ── Hook: resolve the journal whose circle icon a tab should show ──

function useTabJournal(tab: Tab): { color: string | null } | null {
  // Look up the selected entry via the persistent `entriesById` map so
  // this resolves for inactive tabs too (same reason `useTabTitle` uses
  // it rather than the visible `entries` array). The entry's own
  // `journal_id` is the source of truth — not the tab's journal-picker
  // scope (`tab.journalId`), which is not updated when an entry is
  // opened in place.
  const entryJournalId = useEntryStore((s) =>
    tab.selectedEntryId ? (s.entriesById[tab.selectedEntryId]?.journal_id ?? null) : null,
  )
  const journals = useJournalStore((s) => s.journals)
  const effectiveJournalId = entryJournalId ?? tab.journalId
  const journal = effectiveJournalId
    ? (journals.find((j) => j.id === effectiveJournalId) ?? null)
    : null
  return journal ? { color: journal.color } : null
}

// ── Hook: derive a display title for a tab from its state ──

function useTabTitle(tab: Tab): string {
  const { t } = useTranslation('nav')
  const { t: tSettings } = useTranslation('settings')
  // Look up via the persistent `entriesById` map — not the visible `entries`
  // array — so the title resolves even when the active tab has refetched a
  // different journal scope and the previous tab's entry is no longer in
  // the displayed list.
  const selectedEntryTitle = useEntryStore((s) =>
    tab.selectedEntryId ? (s.entriesById[tab.selectedEntryId]?.title ?? null) : null,
  )
  // Daily Chat: resolve the selected conversation's title from the global
  // `chatSessionsById` map (populated by `useDailyChatSessions`). Mirrors the
  // entry-title lookup above — works for inactive tabs too.
  const selectedChatTitle = useChatSessionStore((s) =>
    tab.selectedChatSessionId
      ? (s.chatSessionsById[tab.selectedChatSessionId]?.title ?? null)
      : null,
  )
  // Settings: reflect this tab's category (e.g. "Security"). Per-tab so the
  // strip title matches each app tab independently.
  const settingsCategory = tab.settingsCategory ?? 'security'

  return useMemo(() => {
    // Order matters: the entry-title guard must run first. settings/chat
    // tabs never carry a selectedEntryId, so it can't falsely short-circuit
    // the category/conversation branches below — keep it that way.
    // Dashboard is the exception: applyLaunchView leaves selectedEntryId
    // in place, but the strip should still read the Dashboard view label.
    if (
      tab.activeView !== 'dashboard' &&
      selectedEntryTitle &&
      selectedEntryTitle.trim().length > 0
    ) {
      return selectedEntryTitle
    }
    if (tab.activeView === 'settings') {
      return tSettings(`categories.${settingsCategory}.label`, {
        defaultValue: t(VIEW_LABEL_KEYS.settings),
      })
    }
    if (tab.activeView === 'chat' && selectedChatTitle && selectedChatTitle.trim().length > 0) {
      return selectedChatTitle
    }
    return t(VIEW_LABEL_KEYS[tab.activeView])
  }, [selectedEntryTitle, selectedChatTitle, settingsCategory, tab.activeView, t, tSettings])
}

/**
 * Title-bar logo that optionally tracks the mouse cursor.
 *
 * When enabled, all 6 direction images are rendered stacked on top of each
 * other. Only the active direction is visible. Because every image is always
 * mounted, the browser keeps them decoded — no flash on first visit to a
 * direction.
 */
function TitleBarLogo() {
  const ref = useRef<HTMLSpanElement>(null)
  const direction = useLogoDirection(ref, { titlebarRow: true })

  if (direction == null) {
    return (
      <span ref={ref} className="shrink-0">
        <IconCustom name="XjLogo" size={26} />
      </span>
    )
  }

  return (
    <span ref={ref} className="relative inline-flex size-6.5 shrink-0">
      {ALL_LOGO_DIRECTIONS.map((d) => (
        <img
          key={d}
          src={logoSrc(d)}
          width={26}
          height={26}
          className={cn('absolute inset-0 block', d !== direction && 'invisible')}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ))}
    </span>
  )
}
