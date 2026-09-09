import { useCallback } from 'react'
import { useTabStore } from '../stores/tabStore'
import type { Tab } from '../stores/tabStore'
import type { ActiveView } from '../stores/uiStore'
import type { PaginatedViewKey } from '../types/pagination'

/**
 * Returns the currently active Tab object, or null if no tabs exist.
 */
export function useActiveTab(): Tab | null {
  return useTabStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
}

/**
 * Returns the activeView of the currently active tab.
 * Defaults to 'entries' if no active tab.
 */
export function useActiveView(): ActiveView {
  return useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.activeView ?? 'entries'
  })
}

/**
 * Returns the selectedEntryId of the currently active tab.
 */
export function useSelectedEntryId(): string | null {
  return useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.selectedEntryId ?? null
  })
}

/**
 * Returns the selectedCalendarDate of the currently active tab.
 */
export function useSelectedCalendarDate(): string | null {
  return useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.selectedCalendarDate ?? null
  })
}

/**
 * Returns the updateActiveTab action from tabStore.
 */
export function useUpdateActiveTab(): (patch: Partial<Tab>) => void {
  return useTabStore((s) => s.updateActiveTab)
}

/**
 * Returns the current 1-based page number for the given view key on the active
 * tab. Defaults to 1 if the tab has no pagination state for this view.
 */
export function usePageFor(viewKey: PaginatedViewKey): number {
  return useTabStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.pagination?.[viewKey] ?? 1)
}

/**
 * Returns a stable callback that sets the page for a given view key on the
 * currently active tab. Pages are clamped to ≥ 1.
 */
export function useSetPageFor(): (viewKey: PaginatedViewKey, page: number) => void {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setTabPage = useTabStore((s) => s.setTabPage)
  return useCallback(
    (viewKey: PaginatedViewKey, page: number) => {
      if (activeTabId) setTabPage(activeTabId, viewKey, Math.max(1, page))
    },
    [activeTabId, setTabPage],
  )
}
