import { useUiStore } from '../../src/stores/uiStore'
import { useTabStore } from '../../src/stores/tabStore'
import { isDesignSystem, isTrustedParentEvent, parseDemoCommand } from '../src/demoBridge'

/** Only the embedding page can steer the demo. Payloads never contain CSS/code. */
export function connectDemoBridge() {
  const post = (message: Record<string, unknown>) => {
    if (window.parent !== window)
      window.parent.postMessage({ version: 1, ...message }, location.origin)
  }
  const publishTheme = () => {
    const designSystem = useUiStore.getState().designSystem
    if (isDesignSystem(designSystem)) post({ type: 'memlore-demo-theme', designSystem })
  }
  const unsubscribe = useUiStore.subscribe((state, previous) => {
    if (state.designSystem !== previous.designSystem) publishTheme()
  })
  const listener = (event: MessageEvent) => {
    if (!isTrustedParentEvent(event)) return
    const command = parseDemoCommand(event.data)
    if (!command) return
    if (command.command === 'theme') {
      useUiStore.getState().setDesignSystem(command.designSystem)
    } else if (command.command === 'reset') {
      // Reload creates a new isolated in-memory backend, editor and chat session.
      location.reload()
    } else if (command.command === 'navigate') {
      const tabs = useTabStore.getState()
      if (command.view === 'write')
        tabs.updateActiveTab({ activeView: 'entries', selectedEntryId: 'entry-0001' })
      if (command.view === 'explore')
        tabs.updateActiveTab({ activeView: 'stats', selectedEntryId: null })
      if (command.view === 'chat')
        tabs.updateActiveTab({ activeView: 'chat', selectedChatSessionId: null })
      if (command.view === 'locks')
        tabs.updateActiveTab({
          activeView: 'settings',
          settingsCategory: 'security',
          securityTab: 'second_lock',
        })
    }
  }
  window.addEventListener('message', listener)
  post({ type: 'memlore-demo-ready' })
  publishTheme()
  return () => {
    unsubscribe()
    window.removeEventListener('message', listener)
  }
}
