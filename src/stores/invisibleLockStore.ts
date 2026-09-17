import { create } from 'zustand'
import { useEntryStore } from './entryStore'
import { useJournalStore } from './journalStore'
import { makeDefaultTab, useTabStore } from './tabStore'
import { useTabHistoryStore } from './tabHistoryStore'

interface InvisibleLockState {
  /** Currently open invisible vault, or null when locked. Only one vault at a time. */
  activeVaultId: string | null
  autoLockMinutes: number
  /** Open (or switch to) a single vault — always replaces any previous vault. */
  unlockSession: (vaultId: string) => void
  lockSession: () => void
  setAutoLockMinutes: (minutes: number) => void
}

function clearInvisibleJournalSelection() {
  const { activeJournalId, journals, setActiveJournalId } = useJournalStore.getState()
  if (!activeJournalId) return

  const active = journals.find((journal) => journal.id === activeJournalId)
  if (!active?.is_invisible) return

  const firstVisible = journals.find((journal) => !journal.is_invisible)
  setActiveJournalId(firstVisible?.id ?? null)
}

/** Close tabs whose selected entry is in `entryIds` and drop their history. */
export function closeTabsForEntryIds(entryIds: ReadonlySet<string>) {
  if (entryIds.size === 0) return

  const { tabs, activeTabId } = useTabStore.getState()
  const removedTabs = tabs.filter(
    (tab) => tab.selectedEntryId !== null && entryIds.has(tab.selectedEntryId),
  )
  // A history snapshot can point back to a hidden entry even when the tab
  // currently does not. Drop session history so Back/Forward cannot restore it.
  useTabHistoryStore.setState({ histories: {} })
  if (removedTabs.length === 0) return

  const remainingTabs = tabs.filter(
    (tab) => tab.selectedEntryId === null || !entryIds.has(tab.selectedEntryId),
  )
  const nextTabs = remainingTabs.length > 0 ? remainingTabs : [makeDefaultTab()]
  const activeWasRemoved = removedTabs.some((tab) => tab.id === activeTabId)
  const nextActiveTabId = activeWasRemoved
    ? nextTabs[0].id
    : nextTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : nextTabs[0].id

  useTabStore.setState({ tabs: nextTabs, activeTabId: nextActiveTabId })
  for (const tab of removedTabs) {
    useTabHistoryStore.getState().clearHistory(tab.id)
  }
}

/**
 * Close every tab showing an invisible entry, then drop those entries from the
 * store.
 *
 * Closing the tabs is not enough on its own: `entriesById` accumulates for the
 * whole session and is never replaced wholesale, so every consumer that
 * resolves an entry by id — the tab strip's title and journal colour
 * (`TitleBar`), a mention chip — would keep reading a hidden entry's live title
 * after the vault relocked. Dropping the rows spares each of them its own mask.
 *
 * Not a hard guarantee: `updateEntry` upserts unconditionally, so a late
 * autosave or title-stream resolution landing after the lock can put a row
 * back. No reader exposes one today (the tab is closed, a mention chip
 * re-masks on its next render), but a new by-id reader still has to think
 * about lock state rather than trusting this to have emptied the map.
 */
function clearInvisibleEntriesAndTabs() {
  const { entriesById, removeEntry } = useEntryStore.getState()
  const invisibleEntryIds = new Set(
    Object.values(entriesById)
      .filter((entry) => entry.is_invisible)
      .map((entry) => entry.id),
  )
  // Order is free — the ids are already materialised, and `closeTabsForEntryIds`
  // reads only the tab stores.
  closeTabsForEntryIds(invisibleEntryIds)
  for (const id of invisibleEntryIds) removeEntry(id)
}

/** Same UI clear as lockSession (tabs + journal selection) without touching activeVaultId. */
function clearInvisibleSessionUi() {
  clearInvisibleJournalSelection()
  clearInvisibleEntriesAndTabs()
}

/**
 * After a successful mark-invisible while the session stays locked: drop the
 * entry from the local store so lists/titles do not keep it, and close any
 * open tabs for it (EditorPanel deselects because selectedEntryId is cleared).
 * `vaultId` is the vault the backend assigned (unused locally once removed).
 */
export function hideEntryAfterMarkInvisible(entryId: string, _vaultId: string) {
  const { entriesById, removeEntry } = useEntryStore.getState()
  if (entriesById[entryId]) {
    removeEntry(entryId)
  }
  // Always close tabs by id — entry may not have been in entriesById yet.
  closeTabsForEntryIds(new Set([entryId]))
}

/**
 * Patch local entry flags after toggle while the vault session may stay open.
 * Does not close tabs (caller may still be viewing when unlocked).
 */
export function patchEntryInvisibleFlag(
  entryId: string,
  invisible: boolean,
  vaultId: string | null,
) {
  const existing = useEntryStore.getState().entriesById[entryId]
  if (!existing) return
  useEntryStore.getState().updateEntry({
    ...existing,
    is_invisible: invisible,
    vault_id: invisible ? vaultId : null,
  })
}

export const useInvisibleLockStore = create<InvisibleLockState>((set, get) => ({
  activeVaultId: null,
  autoLockMinutes: 5,
  unlockSession: (vaultId) => {
    const prev = get().activeVaultId
    // Switching vaults must not leave previous vault's open tabs/selection.
    if (prev != null && prev !== vaultId) {
      clearInvisibleSessionUi()
    }
    set({ activeVaultId: vaultId })
  },
  lockSession: () => {
    set({ activeVaultId: null })
    clearInvisibleSessionUi()
  },
  setAutoLockMinutes: (minutes) => set({ autoLockMinutes: Math.max(0, minutes) }),
}))

export type { InvisibleLockState }
