import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Shared "New Entry" action for every trigger point (sidebar button, ⌘N,
 * dashboard Write button, command palette, native OS menu). Honors
 * `newEntryMode`: 'blank' creates the entry immediately (default), 'template'
 * opens the template picker instead — TemplatePickerHost dispatches
 * `memlore:new-entry` itself once a template is chosen.
 */
export function triggerNewEntry() {
  // Mirrors the ⌘N keydown guard in App.tsx — the native-menu path has no
  // equivalent gate of its own, so a locked vault must not open the template
  // picker or switch the active view underneath the lock screen.
  if (useSettingsStore.getState().isLocked) return
  if (useUiStore.getState().newEntryMode === 'template') {
    useUiStore.getState().setTemplatePickerOpen(true)
    return
  }
  // EntryList owns the `memlore:new-entry` listener and only mounts on
  // entries-family views — switch first, then dispatch on the next frame so
  // the listener is attached before the event fires.
  useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null })
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent('memlore:new-entry'))
  })
}
