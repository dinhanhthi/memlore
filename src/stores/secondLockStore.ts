import { create } from 'zustand'
import type { LockedView } from '../lib/tauri'
import { useEntryStore } from './entryStore'
import { makeDefaultTab, useTabStore } from './tabStore'
import { useTabHistoryStore } from './tabHistoryStore'

interface SecondLockState {
  isEnabled: boolean
  isSessionUnlocked: boolean
  showExistence: boolean
  autoLockMinutes: number
  setEnabled: (enabled: boolean) => void
  unlockSession: () => void
  lockSession: () => void
  setShowExistence: (show: boolean) => void
  setAutoLockMinutes: (minutes: number) => void
  lockedView: () => LockedView
}

function clearOpenSecondLockedTabs() {
  const lockedEntryIds = new Set(
    Object.values(useEntryStore.getState().entriesById)
      .filter((entry) => entry.is_locked)
      .map((entry) => entry.id),
  )
  if (lockedEntryIds.size === 0) return

  const { tabs, activeTabId } = useTabStore.getState()
  const removedTabs = tabs.filter(
    (tab) => tab.selectedEntryId !== null && lockedEntryIds.has(tab.selectedEntryId),
  )
  // A history snapshot can point back to a locked entry even when the tab
  // currently does not. Drop the session history on relock so Back/Forward
  // cannot restore protected content.
  useTabHistoryStore.setState({ histories: {} })
  if (removedTabs.length === 0) return

  const remainingTabs = tabs.filter(
    (tab) => tab.selectedEntryId === null || !lockedEntryIds.has(tab.selectedEntryId),
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

export const useSecondLockStore = create<SecondLockState>((set, get) => ({
  isEnabled: false,
  isSessionUnlocked: false,
  showExistence: false,
  autoLockMinutes: 5,
  setEnabled: (enabled) =>
    set((state) => ({
      isEnabled: enabled,
      isSessionUnlocked: enabled ? state.isSessionUnlocked : false,
    })),
  unlockSession: () => set({ isSessionUnlocked: true }),
  lockSession: () => {
    set({ isSessionUnlocked: false })
    clearOpenSecondLockedTabs()
  },
  setShowExistence: (show) => set({ showExistence: show }),
  setAutoLockMinutes: (minutes) => set({ autoLockMinutes: Math.max(0, minutes) }),
  lockedView: () => {
    const state = get()
    if (!state.isEnabled) return 'revealed'
    if (state.isSessionUnlocked) return 'revealed'
    return state.showExistence ? 'covered' : 'hidden'
  },
}))

export type { SecondLockState }
