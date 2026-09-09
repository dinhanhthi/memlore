import { useTabStore } from '../stores/tabStore'

/** Custom event name: last open tab + close request → ask to quit the app. */
export const REQUEST_QUIT_EVENT = 'memlore:request-quit'

/**
 * Close the active tab when more than one tab is open. When this is the last
 * tab, dispatch `memlore:request-quit` so the shell can show a confirmation
 * dialog (we never drop below one tab — see `tabStore.closeTab`).
 *
 * Same-tick double-invocation is ignored so a native menu accelerator and a
 * webview `keydown` handler that both fire for ⌘W do not close two tabs or
 * open the quit dialog twice in one chord.
 */
let inFlight = false

export function requestCloseActiveTab(): void {
  if (inFlight) return
  inFlight = true
  queueMicrotask(() => {
    inFlight = false
  })

  const { tabs, activeTabId, closeTab } = useTabStore.getState()
  if (tabs.length > 1) {
    closeTab(activeTabId)
    return
  }
  window.dispatchEvent(new CustomEvent(REQUEST_QUIT_EVENT))
}
