import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  ActiveView,
  AITab,
  AppearanceTab,
  DataTab,
  EditorTab,
  LocationTab,
  SecurityTab,
  SettingsCategory,
  StatsTab,
  SyncTab,
  TemplatesTab,
} from './uiStore'
import { coerceDataTab } from './uiStore'
import type { PaginatedViewKey } from '../types/pagination'
import { patchAffectsNav, snapshotFromTab, useTabHistoryStore } from './tabHistoryStore'
import { randomId } from '../lib/randomId'

export interface Tab {
  id: string
  journalId: string | null
  activeView: ActiveView
  selectedEntryId: string | null
  selectedCalendarDate: string | null
  /** When `activeView === 'tags'` and this is non-null, the Tags page
   * renders the filtered entry list for this tag (cloud view is hidden).
   * `null` when no tag is selected. Older persisted tabs missing this
   * field are backfilled on rehydrate. */
  selectedTagId: string | null
  /** When `activeView === 'chat'` and this is non-null, Daily Chat keeps
   * this conversation selected (transcript pane open). Lives on the tab
   * — not local component state — so selection survives view switches,
   * tab switches, and mouse back/forward. Older persisted tabs missing
   * this field are backfilled on rehydrate. */
  selectedChatSessionId: string | null
  /** True while `selectedChatSessionId` is an unpersisted Daily Chat draft
   *  (a "New chat" with no message yet — no DB row). Lives on the tab, not
   *  component state, so draft-ness survives view/tab switches and restart:
   *  the transcript keeps skipping its backend load and the "on another page"
   *  banner stays suppressed until the first message persists the session.
   *  Backfilled to `false` on rehydrate for tabs persisted before this field. */
  selectedChatSessionIsDraft?: boolean
  dirty?: boolean
  /** Per-view 1-based page numbers. Persisted so pagination survives restart. */
  pagination?: Partial<Record<PaginatedViewKey, number>>
  /** Pinned tabs are always rendered at the start of the list (in their
   *  pin-order), shown icon-only with no title and no close button.
   *  Backfilled to `false` on rehydrate for tabs persisted before this
   *  field existed. */
  pinned?: boolean
  /**
   * Settings / Statistics navigation for this app tab. Lives on the per-app-tab
   * `Tab` (not global uiStore) so each tab keeps independent settings/stats
   * navigation while surviving unmounts when `activeView` leaves settings/stats.
   * Older persisted tabs missing these fields are backfilled on rehydrate.
   */
  settingsCategory: SettingsCategory
  securityTab: SecurityTab
  locationTab: LocationTab
  aiTab: AITab
  templatesTab: TemplatesTab
  dataTab: DataTab
  editorTab: EditorTab
  appearanceTab: AppearanceTab
  syncTab: SyncTab
  statsTab: StatsTab
  /** Deep-link anchor id for scrolling to a specific settings row.
   *  Set by `navigateToSetting()`, consumed once by `SettingsPanel`
   *  (scroll + highlight), then cleared. Excluded from nav history
   *  so an anchor-only patch never pushes a back/forward entry.
   *  Backfilled to `null` on rehydrate. */
  settingsAnchor?: string | null
}

interface TabState {
  tabs: Tab[]
  activeTabId: string

  /** Create a new tab. When `background` is true, the tab is appended
   *  but the active tab does NOT change — matches browser-style
   *  Cmd-click / "Open in new tab" behaviour. Defaults to false so
   *  existing callers (+ button, ⌘T, menu) keep auto-focusing. */
  newTab: (initial?: Partial<Tab>, opts?: { background?: boolean }) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateActiveTab: (patch: Partial<Tab>) => void
  switchByIndex: (i: number) => void
  setTabPage: (tabId: string, viewKey: PaginatedViewKey, page: number) => void
  /** Reorder tabs by moving the tab with `id` to a new index. No-op if id
   *  doesn't exist or `toIndex` is out of range. Active tab stays the same
   *  (we move the tab, not the focus). The pinned/unpinned partition is
   *  enforced — an unpinned tab cannot be dropped inside the pinned
   *  cluster and vice versa; the target index is clamped into the
   *  source tab's partition. */
  reorderTab: (id: string, toIndex: number) => void
  /** Deep-clone a tab and insert the clone immediately after the source.
   *  The clone gets a fresh id, copies every view-state field (journal,
   *  view, selected entry/date/tag/chat session, pagination), is never
   *  pinned, and is focused. No-op if `id` doesn't exist. */
  duplicateTab: (id: string) => void
  /** Toggle the pinned flag. Pinning moves the tab to the end of the
   *  pinned cluster (start of the list); unpinning moves it to the start
   *  of the unpinned cluster (just after the last pinned tab). No-op if
   *  `id` doesn't exist. Active tab is preserved. */
  togglePinTab: (id: string) => void
}

export function makeDefaultTab(): Tab {
  return {
    id: randomId(),
    journalId: null,
    activeView: 'dashboard',
    selectedEntryId: null,
    selectedCalendarDate: null,
    selectedTagId: null,
    selectedChatSessionId: null,
    dirty: false,
    pinned: false,
    settingsCategory: 'security',
    securityTab: 'device_password',
    locationTab: 'geocoding',
    aiTab: 'chat',
    templatesTab: 'custom',
    dataTab: 'import',
    editorTab: 'general',
    appearanceTab: 'theme',
    syncTab: 'gdrive',
    statsTab: 'charts',
    settingsAnchor: null,
  }
}

/** `createJSONStorage` `getItem` throws on corrupt JSON; treat that as a miss. */
function createSafeJSONStorage() {
  const inner = createJSONStorage(() => localStorage)
  if (!inner) return undefined
  return {
    getItem: (name: string) => {
      try {
        const value = inner.getItem(name)
        if (value instanceof Promise) {
          return value.catch(() => null)
        }
        return value
      } catch {
        return null
      }
    },
    setItem: inner.setItem,
    removeItem: inner.removeItem,
  }
}

// Synchronous initial state: seed a single tab before rehydrate so
// consumers never observe an empty tabs array. `onRehydrateStorage`
// overwrites this if persisted storage has its own tabs.
const initialTab = makeDefaultTab()

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [initialTab],
      activeTabId: initialTab.id,

      newTab: (initial?: Partial<Tab>, opts?: { background?: boolean }) => {
        const { tabs, activeTabId } = get()
        const activeTab = tabs.find((t) => t.id === activeTabId)
        const newId = randomId()
        // Build the new tab: clone active tab's journal, reset view state,
        // apply caller overrides, then force a fresh id (caller cannot
        // override the id — each tab must be uniquely identifiable).
        const tab: Tab = {
          journalId: activeTab?.journalId ?? null,
          activeView: 'dashboard',
          selectedEntryId: null,
          selectedCalendarDate: null,
          selectedTagId: null,
          selectedChatSessionId: null,
          dirty: false,
          pinned: false,
          settingsCategory: 'security',
          securityTab: 'device_password',
          locationTab: 'geocoding',
          aiTab: 'chat',
          templatesTab: 'custom',
          dataTab: 'import',
          editorTab: 'general',
          appearanceTab: 'theme',
          syncTab: 'gdrive',
          statsTab: 'charts',
          settingsAnchor: null,
          ...initial,
          id: newId,
        }
        set({
          tabs: [...tabs, tab],
          activeTabId: opts?.background ? activeTabId : newId,
        })
      },

      closeTab: (id: string) => {
        const { tabs, activeTabId } = get()
        // Never drop below 1 tab
        if (tabs.length <= 1) return
        const idx = tabs.findIndex((t) => t.id === id)
        if (idx === -1) return
        const remaining = tabs.filter((t) => t.id !== id)
        let nextActiveId = activeTabId
        if (activeTabId === id) {
          // Spec: when closing the active tab, focus the first tab in
          // the remaining list. Applies regardless of pinned status —
          // when pinned tabs sit at the front, the first remaining tab
          // is whichever pinned tab is at index 0.
          nextActiveId = remaining[0].id
        }
        set({ tabs: remaining, activeTabId: nextActiveId })
        useTabHistoryStore.getState().clearHistory(id)
      },

      setActiveTab: (id: string) => {
        const { tabs } = get()
        // No-op if id doesn't exist
        if (!tabs.find((t) => t.id === id)) return
        set({ activeTabId: id })
      },

      updateActiveTab: (patch: Partial<Tab>) => {
        const { tabs, activeTabId } = get()
        const prevTab = tabs.find((t) => t.id === activeTabId)
        // Auto-push history: snapshot the PREVIOUS state before applying
        // the patch, so back() restores where the user came from. Three
        // skip conditions:
        //   1. No active tab (shouldn't happen in practice).
        //   2. `isRestoring` — goBack/goForward is calling us; pushing
        //      now would re-stack the state we just popped.
        //   3. Patch doesn't change any NavSnapshot field — `{dirty}`
        //      and `{pinned}` patches flip on every keystroke / pin
        //      toggle. Without this gate, the dedup catches the
        //      no-change push, leaves a phantom top-of-stack equal to
        //      the current view, and the *next* real navigation push
        //      gets silently dropped by that same dedup — Back skips
        //      the intermediate state. See review finding C1.
        if (
          prevTab &&
          !useTabHistoryStore.getState().isRestoring &&
          patchAffectsNav(prevTab, patch)
        ) {
          useTabHistoryStore.getState().pushHistory(activeTabId, snapshotFromTab(prevTab))
        }
        set({
          tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, ...patch, id: t.id } : t)),
        })
      },

      switchByIndex: (i: number) => {
        const { tabs } = get()
        if (i < 0 || i >= tabs.length) return
        set({ activeTabId: tabs[i].id })
      },

      setTabPage: (tabId: string, viewKey: PaginatedViewKey, page: number) => {
        const { tabs, activeTabId } = get()
        const target = tabs.find((t) => t.id === tabId)
        if (!target) return
        const clamped = Math.max(1, page)
        // Push history only when the stored page actually changes for
        // the ACTIVE tab. Reading `pagination?.[viewKey]` directly
        // (not defaulting to 1) preserves the prior behaviour of
        // creating the pagination map on first call even when the
        // clamped value lands on 1.
        const storedPage = target.pagination?.[viewKey]
        const navChange = storedPage !== clamped
        if (navChange && tabId === activeTabId && !useTabHistoryStore.getState().isRestoring) {
          useTabHistoryStore.getState().pushHistory(activeTabId, snapshotFromTab(target))
        }
        set({
          tabs: tabs.map((t) =>
            t.id === tabId ? { ...t, pagination: { ...t.pagination, [viewKey]: clamped } } : t,
          ),
        })
      },

      reorderTab: (id: string, toIndex: number) => {
        const { tabs } = get()
        const fromIndex = tabs.findIndex((t) => t.id === id)
        if (fromIndex === -1) return
        // The pinned cluster always sits at [0, pinnedCount). The unpinned
        // cluster sits at [pinnedCount, tabs.length). Clamp `toIndex` into
        // the source tab's partition so dnd-kit can't cross-pollinate the
        // two — an unpinned tab dragged into the pinned cluster would
        // silently un-pin it and break the visual invariant
        // ([...pinned, ...unpinned]).
        const pinnedCount = tabs.filter((t) => t.pinned === true).length
        const sourcePinned = tabs[fromIndex].pinned === true
        const lo = sourcePinned ? 0 : pinnedCount
        const hi = sourcePinned ? pinnedCount - 1 : tabs.length - 1
        const clampedTo = Math.max(lo, Math.min(toIndex, hi))
        if (fromIndex === clampedTo) return
        const next = tabs.slice()
        const [moved] = next.splice(fromIndex, 1)
        next.splice(clampedTo, 0, moved)
        set({ tabs: next })
      },

      duplicateTab: (id: string) => {
        const { tabs } = get()
        const idx = tabs.findIndex((t) => t.id === id)
        if (idx === -1) return
        const source = tabs[idx]
        const clone: Tab = {
          ...source,
          // Deep-clone the per-view pagination map so later mutations
          // on either tab don't bleed into the other.
          pagination: source.pagination ? { ...source.pagination } : undefined,
          // Clones never inherit the pinned flag — a duplicate of a
          // pinned tab opens as a normal tab, matching Chrome/Arc.
          pinned: false,
          // A clone treats its (copied) chat selection as a real session, not
          // a draft — the draft flag is single-use for the tab that minted it.
          selectedChatSessionIsDraft: false,
          dirty: false,
          id: randomId(),
        }
        // Insert after the source tab. If the source is pinned the clone
        // (unpinned) would land inside the pinned cluster, so push it to
        // the first unpinned slot instead to preserve the partition.
        const pinnedCount = tabs.filter((t) => t.pinned === true).length
        const rawInsertAt = idx + 1
        const insertAt = source.pinned ? Math.max(rawInsertAt, pinnedCount) : rawInsertAt
        const next = tabs.slice()
        next.splice(insertAt, 0, clone)
        set({ tabs: next, activeTabId: clone.id })
      },

      togglePinTab: (id: string) => {
        const { tabs } = get()
        const idx = tabs.findIndex((t) => t.id === id)
        if (idx === -1) return
        const target = tabs[idx]
        const nowPinned = !(target.pinned === true)
        const updated: Tab = { ...target, pinned: nowPinned }
        // Rebuild the array preserving original order within each
        // partition. Pinning → append to pinned cluster (just before the
        // first unpinned tab). Unpinning → prepend to unpinned cluster
        // (just after the last pinned tab). This matches Chrome/Arc:
        // newly pinned tabs go to the end of the pinned strip, freshly
        // unpinned tabs go to the start of the unpinned strip.
        const others = tabs.filter((t) => t.id !== id)
        const pinned = others.filter((t) => t.pinned)
        const unpinned = others.filter((t) => !t.pinned)
        // Sandwich the updated tab between the two clusters. When pinning
        // (pinned=true) it lands at the end of the pinned cluster; when
        // unpinning it lands at the start of the unpinned cluster.
        const nextTabs = [...pinned, updated, ...unpinned]
        set({ tabs: nextTabs })
      },
    }),
    {
      name: 'memlore-tabs',
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        // Hydrate merge can land a non-array `tabs`; mapping that throws and
        // leaves persist.hasHydrated() false (blank unlocked shell).
        tabs: (Array.isArray(state.tabs) ? state.tabs : []).map((t) => ({
          ...t,
          dirty: false,
          selectedChatSessionIsDraft: false,
          selectedChatSessionId: t.selectedChatSessionIsDraft ? null : t.selectedChatSessionId,
        })),
        activeTabId: state.activeTabId,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return
        if (!Array.isArray(state.tabs) || state.tabs.length === 0) {
          const defaultTab = makeDefaultTab()
          useTabStore.setState({ tabs: [defaultTab], activeTabId: defaultTab.id })
          return
        }
        // Backfill fields added after the first persisted release so older
        // tabs don't carry `undefined` where the type says `string | null`.
        // Also coerce unknown union-typed values (renamed sub-tab ids) so
        // downstream lookups never see a value outside the TypeScript union.
        const validCategory: SettingsCategory[] = [
          'general',
          'editor',
          'appearance',
          'security',
          'sync',
          'media',
          'location',
          'journals',
          'templates',
          'reminders',
          'ai',
          'data',
        ]
        const validSecurity: SecurityTab[] = [
          'device_password',
          'second_lock',
          'invisible_lock',
          'recovery_devices',
        ]
        const validLocation: LocationTab[] = ['geocoding', 'default', 'saved']
        const validAi: AITab[] = ['general', 'providers', 'chat', 'features', 'memories', 'persona']
        const validTemplates: TemplatesTab[] = ['custom', 'builtin']
        const validEditor: EditorTab[] = ['font', 'general', 'layout']
        const validSync: SyncTab[] = ['gdrive', 'devices', 'schedule']
        const validStats: StatsTab[] = ['charts', 'insights', 'reviews', 'usage', 'audit']

        state.tabs = state.tabs.map((t) => {
          let settingsCategory: SettingsCategory = t.settingsCategory ?? 'security'
          if (!validCategory.includes(settingsCategory)) settingsCategory = 'appearance'

          let securityTab: SecurityTab = t.securityTab ?? 'device_password'
          if (!validSecurity.includes(securityTab)) securityTab = 'device_password'

          let locationTab: LocationTab = t.locationTab ?? 'geocoding'
          if (!validLocation.includes(locationTab)) locationTab = 'geocoding'

          // Embedding tab merged into Models (`'chat'`). Map the retired id
          // before the generic invalid-value reset would dump the user on General.
          let aiTab: AITab = t.aiTab ?? 'chat'
          if ((aiTab as string) === 'embed') aiTab = 'chat'
          if (!validAi.includes(aiTab)) aiTab = 'general'

          let templatesTab: TemplatesTab = t.templatesTab ?? 'custom'
          if (!validTemplates.includes(templatesTab)) templatesTab = 'custom'

          // `demo` is DEV-only; reject outside DEV so a debug-session selection
          // cannot strand production UI.
          const dataTab = coerceDataTab(t.dataTab ?? 'import')

          let editorTab: EditorTab = t.editorTab ?? 'general'
          if (!validEditor.includes(editorTab)) editorTab = 'general'

          const validAppearance: AppearanceTab[] = ['theme', 'display', 'layout']
          let appearanceTab: AppearanceTab = t.appearanceTab ?? 'theme'
          if (!validAppearance.includes(appearanceTab)) appearanceTab = 'theme'

          let syncTab: SyncTab = t.syncTab ?? 'gdrive'
          if (!validSync.includes(syncTab)) syncTab = 'gdrive'

          let statsTab: StatsTab = t.statsTab ?? 'charts'
          if (!validStats.includes(statsTab)) statsTab = 'charts'

          return {
            ...t,
            selectedTagId: t.selectedTagId ?? null,
            selectedChatSessionId: t.selectedChatSessionId ?? null,
            selectedChatSessionIsDraft: t.selectedChatSessionIsDraft ?? false,
            // Force false: a legacy writer may have stored dirty:true.
            // `t.dirty ?? false` would keep that true and flash "saving".
            dirty: false,
            pinned: t.pinned ?? false,
            settingsCategory,
            securityTab,
            locationTab,
            aiTab,
            templatesTab,
            dataTab,
            editorTab,
            appearanceTab,
            syncTab,
            statsTab,
            settingsAnchor: t.settingsAnchor ?? null,
          }
        })
        // Ensure activeTabId points to a real tab
        if (!state.tabs.find((t) => t.id === state.activeTabId)) {
          useTabStore.setState({ activeTabId: state.tabs[0].id })
        }
      },
    },
  ),
)

/** One-shot per process. Wired from App.tsx in Phase 4.6. */
let launchViewApplied = false

/** Flip the active tab to dashboard once per launch. Uses raw `setState`
 *  (not `updateActiveTab`) so tab history, selection, pin, and order stay put. */
export function applyLaunchView(): void {
  if (launchViewApplied) return
  launchViewApplied = true
  const { tabs, activeTabId } = useTabStore.getState()
  const active = tabs.find((t) => t.id === activeTabId)
  if (!active || active.activeView === 'dashboard') return
  useTabStore.setState({
    tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, activeView: 'dashboard' } : t)),
  })
}

/** Skip the launch flip (web harness seeds its own `activeView`). */
export function markLaunchViewApplied(): void {
  launchViewApplied = true
}

/** Test-only: allow `applyLaunchView` to run again in the next case. */
export function __resetLaunchViewForTests(): void {
  launchViewApplied = false
}
