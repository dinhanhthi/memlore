import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useTabStore } from '../stores/tabStore'
import { useUiStore } from '../stores/uiStore'
import { requestCloseActiveTab } from '../lib/requestCloseActiveTab'
import { triggerNewEntry } from '../lib/newEntry'
import { useSync } from './useSync'

export function useMenuEvents() {
  const newTab = useTabStore((s) => s.newTab)
  const setNewJournalModalOpen = useUiStore((s) => s.setNewJournalModalOpen)
  const setTemplatePickerOpen = useUiStore((s) => s.setTemplatePickerOpen)

  const { syncNow } = useSync()

  useEffect(() => {
    const unlisteners = [
      listen('menu:open-settings', () => {
        newTab({ activeView: 'settings' })
      }),

      // Same "new entry" action as the sidebar button / ⌘N webview shortcut /
      // command palette — honors the newEntryMode setting.
      listen('menu:new-entry', () => {
        triggerNewEntry()
      }),

      listen('menu:new-entry-from-template', () => {
        setTemplatePickerOpen(true)
      }),

      listen('menu:new-journal', () => {
        setNewJournalModalOpen(true)
      }),

      listen('menu:sync-now', () => {
        void syncNow().catch(() => {})
      }),

      // Window > Close Tab (⌘W) — same path as the webview keydown handler.
      listen('menu:close-tab', () => {
        requestCloseActiveTab()
      }),
    ]

    return () => {
      void Promise.all(unlisteners).then((fns) => fns.forEach((fn) => fn()))
    }
  }, [newTab, setTemplatePickerOpen, setNewJournalModalOpen, syncNow])
}
