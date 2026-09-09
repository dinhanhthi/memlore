import { create } from 'zustand'
import type { Tab } from './tabStore'
import type {
  ActiveView,
  AITab,
  DataTab,
  EditorTab,
  LocationTab,
  SecurityTab,
  SettingsCategory,
  StatsTab,
  SyncTab,
  TemplatesTab,
} from './uiStore'
import type { PaginatedViewKey } from '../types/pagination'

/**
 * Per-tab navigation history. Not persisted: history is session-only,
 * cleared on app restart (matches browser session-history semantics).
 *
 * A "snapshot" captures the full navigable view-state of a tab — every
 * field that meaningfully changes what the user is looking at. `dirty`
 * and `pinned` are intentionally omitted: `dirty` is transient editor
 * state, `pinned` is a tab-strip property, neither is a navigation
 * destination.
 */
export interface NavSnapshot {
  journalId: string | null
  activeView: ActiveView
  selectedEntryId: string | null
  selectedCalendarDate: string | null
  selectedTagId: string | null
  selectedChatSessionId: string | null
  pagination?: Partial<Record<PaginatedViewKey, number>>
  /** Settings/stats nav — per app-tab so back/forward restores category + sub-tabs. */
  settingsCategory: SettingsCategory
  securityTab: SecurityTab
  locationTab: LocationTab
  aiTab: AITab
  templatesTab: TemplatesTab
  dataTab: DataTab
  editorTab: EditorTab
  syncTab: SyncTab
  statsTab: StatsTab
}

interface TabHistory {
  back: NavSnapshot[]
  forward: NavSnapshot[]
}

interface TabHistoryState {
  /** Per-tab back/forward stacks. Missing tabs default to empty stacks. */
  histories: Record<string, TabHistory>
  /** True while a back/forward restore is in flight — used by tabStore
   *  to skip the auto-push so we don't push the very state we just
   *  popped. Module-level flag would also work, but keeping it in the
   *  store keeps everything observable in one place. */
  isRestoring: boolean

  /** Push a snapshot onto the back stack for `tabId`. Caller is
   *  expected to have already mutated the tab — this just records
   *  the PREVIOUS state so back() can restore it. Dedupes against
   *  the top of the back stack to avoid filling history with no-op
   *  pushes (same view, same selection). Clears the forward stack
   *  per standard browser semantics (new navigation invalidates
   *  any forward history). Capped at HISTORY_CAP entries per tab
   *  to keep memory bounded over long sessions. */
  pushHistory: (tabId: string, previous: NavSnapshot) => void
  /** Pop one entry from back, return it; push the current snapshot
   *  onto forward so goForward() can return here. Returns null if
   *  the back stack is empty. */
  popBack: (tabId: string, current: NavSnapshot) => NavSnapshot | null
  /** Mirror of popBack for the forward stack. */
  popForward: (tabId: string, current: NavSnapshot) => NavSnapshot | null
  /** True iff the tab has at least one back entry. */
  canGoBack: (tabId: string) => boolean
  canGoForward: (tabId: string) => boolean
  /** Drop the tab's history. Called from tabStore.closeTab. */
  clearHistory: (tabId: string) => void
  /** Internal — set by goBack/goForward around the updateActiveTab call. */
  setRestoring: (flag: boolean) => void
}

const HISTORY_CAP = 50

function paginationEqual(a: NavSnapshot['pagination'], b: NavSnapshot['pagination']): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<PaginatedViewKey>
  for (const k of keys) {
    if (a[k] !== b[k]) return false
  }
  return true
}

function snapshotsEqual(a: NavSnapshot, b: NavSnapshot): boolean {
  // Shallow per-field comparison. Pagination is the only non-primitive
  // and is shallow-compared by entries — different object references
  // with the same {viewKey: page} contents are treated as equal so the
  // dedup catches re-entry from memoized hook callers.
  return (
    a.journalId === b.journalId &&
    a.activeView === b.activeView &&
    a.selectedEntryId === b.selectedEntryId &&
    a.selectedCalendarDate === b.selectedCalendarDate &&
    a.selectedTagId === b.selectedTagId &&
    a.selectedChatSessionId === b.selectedChatSessionId &&
    paginationEqual(a.pagination, b.pagination) &&
    a.settingsCategory === b.settingsCategory &&
    a.securityTab === b.securityTab &&
    a.locationTab === b.locationTab &&
    a.aiTab === b.aiTab &&
    a.templatesTab === b.templatesTab &&
    a.dataTab === b.dataTab &&
    a.editorTab === b.editorTab &&
    a.syncTab === b.syncTab &&
    a.statsTab === b.statsTab
  )
}

/** Field names of `Tab` that map to `NavSnapshot`. The single source of
 *  truth — `snapshotFromTab` and the patch-relevance gate in
 *  `tabStore.updateActiveTab` both consume this so a future field added
 *  to one stays in sync with the other. */
export const NAV_KEYS = [
  'journalId',
  'activeView',
  'selectedEntryId',
  'selectedCalendarDate',
  'selectedTagId',
  'selectedChatSessionId',
  'pagination',
  'settingsCategory',
  'securityTab',
  'locationTab',
  'aiTab',
  'templatesTab',
  'dataTab',
  'editorTab',
  'syncTab',
  'statsTab',
] as const satisfies ReadonlyArray<keyof Tab & keyof NavSnapshot>

export function snapshotFromTab(tab: Tab): NavSnapshot {
  return {
    journalId: tab.journalId,
    activeView: tab.activeView,
    selectedEntryId: tab.selectedEntryId,
    selectedCalendarDate: tab.selectedCalendarDate,
    selectedTagId: tab.selectedTagId,
    selectedChatSessionId: tab.selectedChatSessionId,
    pagination: tab.pagination,
    settingsCategory: tab.settingsCategory,
    securityTab: tab.securityTab,
    locationTab: tab.locationTab,
    aiTab: tab.aiTab,
    templatesTab: tab.templatesTab,
    dataTab: tab.dataTab,
    editorTab: tab.editorTab,
    syncTab: tab.syncTab,
    statsTab: tab.statsTab,
  }
}

/** True iff the patch changes at least one nav-relevant field on the
 *  given tab. Used to skip auto-push for non-nav patches like
 *  `{dirty}` or `{pinned}` — those flip frequently (every keystroke
 *  for `dirty`) and would otherwise fill history with phantom entries
 *  whose dedup hits silently swallow the next real navigation push. */
export function patchAffectsNav(prev: Tab, patch: Partial<Tab>): boolean {
  for (const k of NAV_KEYS) {
    if (k in patch) {
      if (k === 'pagination') {
        if (!paginationEqual(prev.pagination, patch.pagination)) return true
      } else if (patch[k] !== prev[k]) {
        return true
      }
    }
  }
  return false
}

export const useTabHistoryStore = create<TabHistoryState>()((set, get) => ({
  histories: {},
  isRestoring: false,

  pushHistory: (tabId, previous) => {
    const { histories } = get()
    const current = histories[tabId] ?? { back: [], forward: [] }
    const top = current.back[current.back.length - 1]
    if (top && snapshotsEqual(top, previous)) return
    const nextBack = [...current.back, previous]
    // Drop oldest when over cap. slice() copies — fine at 50 entries.
    const capped = nextBack.length > HISTORY_CAP ? nextBack.slice(-HISTORY_CAP) : nextBack
    set({
      histories: {
        ...histories,
        [tabId]: { back: capped, forward: [] },
      },
    })
  },

  popBack: (tabId, current) => {
    const { histories } = get()
    const entry = histories[tabId]
    if (!entry || entry.back.length === 0) return null
    const target = entry.back[entry.back.length - 1]
    const nextBack = entry.back.slice(0, -1)
    const nextForward = [...entry.forward, current]
    set({
      histories: {
        ...histories,
        [tabId]: { back: nextBack, forward: nextForward },
      },
    })
    return target
  },

  popForward: (tabId, current) => {
    const { histories } = get()
    const entry = histories[tabId]
    if (!entry || entry.forward.length === 0) return null
    const target = entry.forward[entry.forward.length - 1]
    const nextForward = entry.forward.slice(0, -1)
    const nextBack = [...entry.back, current]
    set({
      histories: {
        ...histories,
        [tabId]: { back: nextBack, forward: nextForward },
      },
    })
    return target
  },

  canGoBack: (tabId) => {
    const entry = get().histories[tabId]
    return !!entry && entry.back.length > 0
  },

  canGoForward: (tabId) => {
    const entry = get().histories[tabId]
    return !!entry && entry.forward.length > 0
  },

  clearHistory: (tabId) => {
    const { histories } = get()
    if (!(tabId in histories)) return
    const next = { ...histories }
    delete next[tabId]
    set({ histories: next })
  },

  setRestoring: (flag) => set({ isRestoring: flag }),
}))
