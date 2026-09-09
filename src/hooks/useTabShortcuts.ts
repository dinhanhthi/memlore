import { useEffect } from 'react'
import { useTabStore } from '../stores/tabStore'
import { requestCloseActiveTab } from '../lib/requestCloseActiveTab'

/**
 * Registers global keyboard shortcuts for tab management:
 *
 * | Shortcut         | Action                                 |
 * |------------------|----------------------------------------|
 * | ⌘T               | newTab()                               |
 * | ⌘W               | close active tab (or confirm quit on   |
 * |                  | the last tab — see requestCloseActiveTab)|
 * | ⌘1..9            | switchByIndex(N-1)                     |
 * | ⌘Shift+← / →    | prev/next tab                          |
 * | ⌘K               | Search overlay (handled in App.tsx)    |
 *
 * All shortcuts fire unconditionally — even when a text input / contenteditable
 * (TipTap editor) has focus. Meta/Ctrl-prefixed combos don't conflict with
 * normal typing, so guarding on the focus target would only prevent users from
 * switching tabs while they're writing — matching browser behavior (⌘T opens
 * a tab no matter what element is focused).
 *
 * Wire this hook from App.tsx (once, when the app is unlocked).
 */
export function useTabShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      if (!mod) return

      // ⌘W — close active tab (last tab → quit confirm)
      if (e.key === 'w') {
        e.preventDefault()
        requestCloseActiveTab()
        return
      }

      // ⌘Shift+Arrow — navigate tabs
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const { tabs, activeTabId, setActiveTab } = useTabStore.getState()
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        if (idx === -1) return
        const len = tabs.length
        if (e.key === 'ArrowRight') {
          setActiveTab(tabs[(idx + 1) % len].id)
        } else {
          setActiveTab(tabs[(idx - 1 + len) % len].id)
        }
        return
      }

      // ⌘T — new tab
      if (e.key === 't') {
        e.preventDefault()
        useTabStore.getState().newTab()
        return
      }

      // ⌘1..9 — switch by index
      const digit = parseInt(e.key, 10)
      if (!isNaN(digit) && digit >= 1 && digit <= 9) {
        e.preventDefault()
        useTabStore.getState().switchByIndex(digit - 1)
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
