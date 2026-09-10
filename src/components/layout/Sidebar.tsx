import { FloatingPortal } from '@floating-ui/react'
import { ExternalLink, PenLine, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useActiveView, useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useAiDailyChatEnabled } from '../../hooks/useAiDailyChatEnabled'
import { useJournals } from '../../hooks/useJournals'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { cn } from '../../lib/cn'
import { isMiddleClick, isNewTabModifier } from '../../lib/modifierClick'
import { SIDEBAR_VIEW_ICONS } from '../../lib/viewIcons'
import { useTabStore } from '../../stores/tabStore'
import type { ActiveView } from '../../stores/uiStore'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { JournalForm } from '../journals/JournalForm'

interface NavItem {
  view: ActiveView
  /// i18n key inside the `nav` namespace (e.g. `all_entries`).
  labelKey: string
  icon: LucideIcon
}

// Bundle order first, then our extras (decision #4 in SPECIFICATION.md).
// The four "coming-soon" views (onthisday/media/map/stats) render through
// TwoPanelLayout's EntryList fallback until Chunk E lands their placeholder
// pages. No client-side differentiation needed here — the fallback handles it.
const NAV_ITEMS: NavItem[] = [
  { view: 'dashboard', labelKey: 'dashboard', icon: SIDEBAR_VIEW_ICONS.dashboard! },
  { view: 'entries', labelKey: 'all_entries', icon: SIDEBAR_VIEW_ICONS.entries! },
  { view: 'calendar', labelKey: 'calendar', icon: SIDEBAR_VIEW_ICONS.calendar! },
  { view: 'tags', labelKey: 'tags', icon: SIDEBAR_VIEW_ICONS.tags! },
  { view: 'onthisday', labelKey: 'onthisday', icon: SIDEBAR_VIEW_ICONS.onthisday! },
  { view: 'media', labelKey: 'media', icon: SIDEBAR_VIEW_ICONS.media! },
  { view: 'map', labelKey: 'map', icon: SIDEBAR_VIEW_ICONS.map! },
  { view: 'stats', labelKey: 'stats', icon: SIDEBAR_VIEW_ICONS.stats! },
  // Templates & Prompts are not sidebar items — they live under Settings.
  { view: 'settings', labelKey: 'settings', icon: SIDEBAR_VIEW_ICONS.settings! },
]

// Phase 6 v2 R9 — Daily Chat nav item, conditionally surfaced when the
// `ai_daily_chat_enabled` flag is on. Inserted right before `settings` at
// render time (see `displayItems` below) so the hardcoded ordering above
// stays as the authoritative non-AI list.
const CHAT_ITEM: NavItem = { view: 'chat', labelKey: 'chat', icon: SIDEBAR_VIEW_ICONS.chat! }
const ABOUT_ITEM: NavItem = { view: 'about', labelKey: 'about', icon: SIDEBAR_VIEW_ICONS.about! }

export function Sidebar() {
  const { t } = useTranslation('nav')
  const { sidebarCollapsed, toggleSidebar, newJournalModalOpen, setNewJournalModalOpen } =
    useUiStore()
  const { sidebarRight } = useLayoutFlags()
  const designSystem = useUiStore((s) => s.designSystem)
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'
  const activeView = useActiveView()
  const updateActiveTab = useUpdateActiveTab()
  const dailyChatEnabled = useAiDailyChatEnabled()
  // Splice AI nav items before Settings when their toggles are on.
  // `null` (initial probe pending) suppresses the item — avoids a paint flash.
  const beforeSettings = NAV_ITEMS.slice(0, -1)
  const settingsItem = NAV_ITEMS[NAV_ITEMS.length - 1]
  const aiItems: NavItem[] = []
  if (dailyChatEnabled === true) aiItems.push(CHAT_ITEM)
  const displayItems: NavItem[] = [...beforeSettings, ...aiItems, settingsItem, ABOUT_ITEM]
  const { createJournal } = useJournals()
  const [contextMenu, setContextMenu] = useState<{
    view: ActiveView
    anchor: { x: number; y: number }
  } | null>(null)

  // `useTabStore.getState()` over `useTabStore(s => s.newTab)`: Zustand
  // action identities are stable, so subscribing buys nothing here and
  // avoids re-rendering Sidebar when unrelated tab state changes.
  const openViewInNewTab = (view: ActiveView) => {
    useTabStore.getState().newTab(
      {
        activeView: view,
        selectedEntryId: null,
        selectedCalendarDate: null,
        selectedTagId: null,
        selectedChatSessionId: null,
      },
      { background: true },
    )
  }

  const [formError, setFormError] = useState<string | null>(null)

  const closeJournalForm = () => {
    setFormError(null)
    setNewJournalModalOpen(false)
  }

  const handleSaveJournal = async (
    name: string,
    color: string | undefined,
    autoTagIds: string[] | undefined,
  ) => {
    try {
      setFormError(null)
      await createJournal(name, color, autoTagIds ?? [])
      closeJournalForm()
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save journal')
    }
  }

  const newEntryLabel = t('new_entry')
  // Morph width with the sidebar (always w-full + h-9). Icon is pin-left
  // (justify-start + constant padding + gap-0) so it never drifts — spacing to
  // the label lives on the label's margin, not on flex gap / justify-center
  // (those reflow the icon when max-width collapses).
  const newEntryButton = (
    <Button
      variant="primary"
      size="sm"
      aria-label={newEntryLabel}
      icon={<PenLine className="size-4 shrink-0" strokeWidth={2} />}
      onClick={() => {
        // EntryList owns the event listener, so ensure it mounts before
        // dispatching when New Entry is clicked from a non-entry view.
        updateActiveTab({ activeView: 'entries', selectedEntryId: null })
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('memlore:new-entry')))
      }}
      // px-2.5 centers the 16px icon in the collapsed ~36px CTA (w-12 − px-1.5×2).
      // gap-0 overrides primary's gap-2 so label spacing can live on the span.
      className="h-9 w-full min-w-0 justify-start gap-0 overflow-hidden px-2.5"
    >
      <span
        aria-hidden="true"
        className={cn(
          // min-w-0 lets max-w-0 actually collapse in a flex row (default
          // min-width:auto would keep the label's intrinsic width).
          'inline-block min-w-0 overflow-hidden text-sm whitespace-nowrap transition-[max-width,margin,opacity] duration-300 ease-(--motion-ease-out-expo) motion-reduce:transition-none',
          sidebarCollapsed ? 'ml-0 max-w-0 opacity-0' : 'ml-2 max-w-24 opacity-100',
        )}
      >
        {newEntryLabel}
      </span>
    </Button>
  )

  return (
    <>
      <aside
        className={cn(
          isClean
            ? sidebarRight
              ? 'border-border-default border-l'
              : 'border-border-default border-r'
            : '',
          isClay && 'bg-transparent',
          'relative z-10 flex h-full min-h-0 w-full shrink-0 flex-col transition-[width] duration-300 ease-(--motion-ease-out-expo) motion-reduce:transition-none',
          sidebarCollapsed ? 'w-12' : 'w-36',
        )}
      >
        {/* Constant px-1.5 (matches nav) so the button's left edge — and thus the
            pen icon — never shifts when the sidebar width animates. */}
        <div className="shrink-0 px-1.5 pt-3">
          <Tooltip
            content={newEntryLabel}
            placement={sidebarRight ? 'left' : 'right'}
            disabled={!sidebarCollapsed}
            className="w-full"
          >
            {newEntryButton}
          </Tooltip>
        </div>
        {/* Nav items — same selected-tab chrome ears as titlebar, left→right.
            End spacers keep first/last active ears inside overflow-y content. */}
        <nav className="xj-sidebar-nav flex flex-1 flex-col gap-1.5 overflow-x-hidden overflow-y-auto px-1.5 pt-3">
          {displayItems.map(({ view, labelKey, icon: NavIcon }) => {
            const isActive = activeView === view
            const displayLabel = t(labelKey)
            const btn = (
              <button
                key={view}
                type="button"
                aria-label={displayLabel}
                onClick={(e) => {
                  if (isNewTabModifier(e)) {
                    e.preventDefault()
                    openViewInNewTab(view)
                    return
                  }
                  if (view === 'search') {
                    useUiStore.getState().setSearchOverlayOpen(true)
                    updateActiveTab({ activeView: 'search', selectedEntryId: null })
                  } else {
                    updateActiveTab({ activeView: view, selectedEntryId: null })
                  }
                }}
                onMouseDown={(e) => {
                  if (isMiddleClick(e)) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (isMiddleClick(e)) {
                    e.preventDefault()
                    openViewInNewTab(view)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ view, anchor: { x: e.clientX, y: e.clientY } })
                }}
                className={cn(
                  'group relative flex items-center gap-3 px-2.5 py-2 text-sm font-medium',
                  'h-9 transition-[background-color,color,box-shadow] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
                  'w-full text-left select-none',
                  isClean && 'h-8 gap-2 px-2',
                  isActive
                    ? isClean
                      ? 'xj-nav-active text-fg z-10 rounded-md bg-(--nav-active-bg) font-medium'
                      : isClay
                        ? 'xj-nav-active text-fg z-10 rounded-lg bg-(--nav-active-bg) font-medium'
                        : sidebarRight
                          ? 'text-fg bg-elevated z-10 -ml-1.5 rounded-l-none rounded-r-full font-medium'
                          : 'text-fg bg-elevated z-10 ml-1.5 rounded-l-full rounded-r-none font-medium'
                    : isClean
                      ? 'text-fg-muted hover:text-fg rounded-md bg-transparent font-normal hover:bg-(--nav-hover-bg)'
                      : isClay
                        ? 'text-fg-muted hover:bg-surface-hi hover:text-fg rounded-lg bg-transparent'
                        : 'text-fg-muted hover:bg-elevated hover:text-fg dark:hover:bg-surface-hi rounded-full bg-transparent',
                )}
              >
                {isActive && !isClay && (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        'xj-nav-chrome-corner xj-nav-chrome-corner-top',
                        sidebarRight && 'xj-nav-chrome-corner-flip',
                      )}
                    />
                    <span
                      aria-hidden
                      className={cn(
                        'xj-nav-chrome-corner xj-nav-chrome-corner-bottom',
                        sidebarRight && 'xj-nav-chrome-corner-flip',
                      )}
                    />
                  </>
                )}
                <span
                  className={cn(
                    'shrink-0 transition-[color,opacity] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
                    isActive
                      ? 'text-accent'
                      : 'text-fg-muted group-hover:text-fg opacity-70 group-hover:opacity-100',
                  )}
                >
                  <NavIcon className="size-(--ui-icon-size)" strokeWidth={1.75} />
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {displayLabel}
                </span>
              </button>
            )
            if (sidebarCollapsed) {
              return (
                <Tooltip
                  key={view}
                  content={displayLabel}
                  placement={sidebarRight ? 'left' : 'right'}
                >
                  {btn}
                </Tooltip>
              )
            }
            return btn
          })}
          <span aria-hidden className="xj-nav-strip-end-space" />
          {/* Clickable filler — expands sidebar when collapsed and user clicks empty space below items */}
          {sidebarCollapsed && (
            <button
              type="button"
              aria-label={t('sidebar.expand')}
              onClick={toggleSidebar}
              className="w-full flex-1 cursor-ew-resize"
            />
          )}
        </nav>
      </aside>

      {contextMenu && (
        <SidebarContextMenu
          anchor={contextMenu.anchor}
          onClose={() => setContextMenu(null)}
          onOpenInNewTab={() => {
            openViewInNewTab(contextMenu.view)
            setContextMenu(null)
          }}
        />
      )}

      {/* Journal form modal — opened locally or via menu:new-journal */}
      {newJournalModalOpen && (
        <JournalForm
          journal={null}
          onSave={handleSaveJournal}
          onCancel={closeJournalForm}
          externalError={formError}
        />
      )}
    </>
  )
}

interface SidebarContextMenuProps {
  anchor: { x: number; y: number }
  onClose: () => void
  onOpenInNewTab: () => void
}

function SidebarContextMenu({ anchor, onClose, onOpenInNewTab }: SidebarContextMenuProps) {
  const { t } = useTranslation('nav')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const MENU_W = 200
  // Single-item menu; update if more items are added or switch to a
  // ref-measured height (see EntryContextMenu for the measured pattern).
  const ESTIMATED_H = 44
  const x = Math.max(8, Math.min(anchor.x, window.innerWidth - MENU_W - 8))
  const y = Math.max(8, Math.min(anchor.y, window.innerHeight - ESTIMATED_H - 8))

  return (
    <FloatingPortal>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('sidebar_item_actions')}
        style={{ position: 'fixed', top: y, left: x, zIndex: 60 }}
        className="border-border-default bg-elevated rounded-xl border p-1 shadow-lg"
      >
        <button
          type="button"
          role="menuitem"
          onClick={onOpenInNewTab}
          className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors"
          style={{ width: MENU_W - 8 }}
        >
          <span className="text-fg-muted shrink-0">
            <ExternalLink className="size-3.5" />
          </span>
          <span className="flex-1 truncate">{t('open_in_new_tab')}</span>
        </button>
      </div>
    </FloatingPortal>
  )
}
