import { useCallback } from 'react'
import { useTabStore } from '../stores/tabStore'
import { snapshotFromTab, useTabHistoryStore } from '../stores/tabHistoryStore'

/**
 * Back/forward navigation for the active tab. Mirrors browser session
 * history: back restores the previous in-tab view, forward un-does a
 * back. Both no-op when their respective stack is empty.
 *
 * The `isRestoring` flag guards `tabStore.updateActiveTab` from
 * pushing the restore itself onto history — otherwise back→forward
 * would oscillate between two states forever.
 */
/** Empty dep arrays are intentional in both callbacks below: every store
 *  read goes through `.getState()` so no values are captured by closure.
 *  Adding `useTabStore((s) => s.tabs)` here would silently desync — keep
 *  store access inside the callback bodies. */
export function useTabNavigation() {
  const goBack = useCallback(() => {
    const tabState = useTabStore.getState()
    const tab = tabState.tabs.find((t) => t.id === tabState.activeTabId)
    if (!tab) return
    const history = useTabHistoryStore.getState()
    if (!history.canGoBack(tab.id)) return
    const target = history.popBack(tab.id, snapshotFromTab(tab))
    if (!target) return
    history.setRestoring(true)
    try {
      tabState.updateActiveTab(target)
    } finally {
      history.setRestoring(false)
    }
  }, [])

  const goForward = useCallback(() => {
    const tabState = useTabStore.getState()
    const tab = tabState.tabs.find((t) => t.id === tabState.activeTabId)
    if (!tab) return
    const history = useTabHistoryStore.getState()
    if (!history.canGoForward(tab.id)) return
    const target = history.popForward(tab.id, snapshotFromTab(tab))
    if (!target) return
    history.setRestoring(true)
    try {
      tabState.updateActiveTab(target)
    } finally {
      history.setRestoring(false)
    }
  }, [])

  return { goBack, goForward }
}
