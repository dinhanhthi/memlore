import { create } from 'zustand'

/**
 * Live word/char counters for the currently open entry.
 *
 * The underlying `Entry.content_text` field on the server/database only
 * refreshes after the 1500 ms auto-save debounce. During typing that value
 * is stale, so the FooterBar (which drives the "247 words · 1,483 chars"
 * strip) would sit frozen until the next save.
 *
 * Fix: the Editor publishes word/char counts on every TipTap `onUpdate`
 * into this store; FooterBar reads from here instead of counting entry
 * content directly. Scoped by entryId so a stale count never leaks into
 * a freshly-selected entry.
 */
interface EditorMetricsState {
  entryId: string | null
  words: number
  chars: number
  /**
   * Set to `true` when the user explicitly edits the entry date pill.
   * While `true`, the multi-EXIF date suggestion hook suppresses all
   * date picker prompts — the user has already made their choice.
   * Reset to `false` on `clear()` (i.e. when the entry is closed /
   * navigated away from).
   */
  entryDateUserEdited: boolean
  /**
   * Set to `true` when the user explicitly edits the entry location.
   * While `true`, the location suggestion hook suppresses all
   * location prompts — the user has already made their choice.
   * Reset to `false` on `clear()` (i.e. when the entry is closed /
   * navigated away from).
   */
  entryLocationUserEdited: boolean
  setMetrics: (entryId: string, words: number, chars: number) => void
  setEntryDateUserEdited: (edited: boolean) => void
  setEntryLocationUserEdited: (edited: boolean) => void
  clear: () => void
}

export const useEditorMetricsStore = create<EditorMetricsState>()((set) => ({
  entryId: null,
  words: 0,
  chars: 0,
  entryDateUserEdited: false,
  entryLocationUserEdited: false,

  setMetrics: (entryId, words, chars) => set({ entryId, words, chars }),
  setEntryDateUserEdited: (edited) => set({ entryDateUserEdited: edited }),
  setEntryLocationUserEdited: (edited) => set({ entryLocationUserEdited: edited }),
  clear: () =>
    set({
      entryId: null,
      words: 0,
      chars: 0,
      entryDateUserEdited: false,
      entryLocationUserEdited: false,
    }),
}))
