import { create } from 'zustand'
import type { Template } from '../types/template'

interface TemplateState {
  templates: Template[]
  /**
   * Transient queue of "apply this template to this freshly-created entry"
   * handoffs. Set when the user picks a template from `TemplatePicker` while
   * creating a new entry; cleared by the editor once it mounts the entry and
   * applies the template content. Not persisted.
   */
  pendingByEntryId: Record<string, Template>

  setTemplates: (templates: Template[]) => void
  enqueuePendingTemplate: (entryId: string, template: Template) => void
  consumePendingTemplate: (entryId: string) => Template | undefined
}

export const useTemplateStore = create<TemplateState>()((set, get) => ({
  templates: [],
  pendingByEntryId: {},

  setTemplates: (templates) => set({ templates }),

  enqueuePendingTemplate: (entryId, template) =>
    set((s) => ({
      pendingByEntryId: { ...s.pendingByEntryId, [entryId]: template },
    })),

  consumePendingTemplate: (entryId) => {
    const pending = get().pendingByEntryId[entryId]
    if (!pending) return undefined
    set((s) => {
      const next = { ...s.pendingByEntryId }
      delete next[entryId]
      return { pendingByEntryId: next }
    })
    return pending
  },
}))
