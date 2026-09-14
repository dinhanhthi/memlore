import { useUiStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { useTemplates } from '../../hooks/useTemplates'
import { TemplatePicker } from './TemplatePicker'
import type { Template } from '../../types/template'

/**
 * App-level host for the TemplatePicker so File > New Entry from Template
 * opens the modal over whatever view is active. Entry creation still belongs
 * to EntryList (it owns the journal filter, tag auto-attach and the pending
 * template queue), so picking a template switches to the entries view and
 * hands the template over on `memlore:new-entry` — same switch-then-dispatch
 * sequence as `triggerNewEntry` in src/lib/newEntry.ts. Cancelling leaves the
 * current view untouched.
 */
export function TemplatePickerHost() {
  const setTemplatePickerOpen = useUiStore((s) => s.setTemplatePickerOpen)
  const updateActiveTab = useTabStore((s) => s.updateActiveTab)
  const { templates, isLoading } = useTemplates()

  const handleSelect = (template: Template) => {
    setTemplatePickerOpen(false)
    // The "blank" predefined template intentionally carries empty content —
    // don't pass it along, just create a plain entry. The name field stores
    // the slug key ('blank') now that display names are resolved via i18n.
    const isBlank = template.name === 'blank' && template.is_predefined
    updateActiveTab({ activeView: 'entries', selectedEntryId: null })
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('memlore:new-entry', {
          detail: { template: isBlank ? null : template },
        }),
      )
    })
  }

  // The store starts empty and isn't persisted; EntryList used to warm it on
  // mount. Hold the modal back on a cold first open rather than popping an
  // empty grid. `isLoading` is true on every mount, hence the length guard.
  if (isLoading && templates.length === 0) return null

  return (
    <TemplatePicker
      templates={templates}
      onSelect={handleSelect}
      onClose={() => setTemplatePickerOpen(false)}
    />
  )
}
