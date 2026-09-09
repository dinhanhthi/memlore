import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useTabStore } from '../stores/tabStore'
import { useUiStore } from '../stores/uiStore'
import { useJournalStore } from '../stores/journalStore'
import { requestCloseActiveTab } from '../lib/requestCloseActiveTab'
import { useEntries } from './useEntries'
import { useSync } from './useSync'

export function useMenuEvents() {
  const newTab = useTabStore((s) => s.newTab)
  const updateActiveTab = useTabStore((s) => s.updateActiveTab)
  const setNewJournalModalOpen = useUiStore((s) => s.setNewJournalModalOpen)
  const setTemplatePickerOpen = useUiStore((s) => s.setTemplatePickerOpen)
  const activeJournalId = useJournalStore((s) => s.activeJournalId)
  const journals = useJournalStore((s) => s.journals)

  const { createEntry } = useEntries({})
  const { syncNow } = useSync()

  useEffect(() => {
    const unlisteners = [
      listen('menu:open-settings', () => {
        newTab({ activeView: 'settings' })
      }),

      listen('menu:new-entry', async () => {
        const journalId = activeJournalId ?? journals[0]?.id
        if (!journalId) return
        try {
          const entry = await createEntry({
            journal_id: journalId,
            entry_date: Date.now(),
          })
          updateActiveTab({ selectedEntryId: entry.id })
        } catch {
          // ignore — entry list stays unchanged
        }
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
  }, [
    newTab,
    updateActiveTab,
    activeJournalId,
    journals,
    createEntry,
    setTemplatePickerOpen,
    setNewJournalModalOpen,
    syncNow,
  ])
}
