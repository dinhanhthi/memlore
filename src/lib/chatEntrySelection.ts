import type { ChatAttachment } from '../types/ai'

type EntryAttachment = Extract<ChatAttachment, { kind: 'entry' }>

/**
 * Toggle an entry attachment in/out of a selection list, keeping insertion
 * order stable so the shared Attach button commits the same chip order the
 * user built up. Adding past `cap` is a no-op — the caller (`ChatAttachPopover`)
 * is expected to also disable the row so this is a belt-and-braces guard, not
 * the primary UX signal.
 */
export function toggleEntrySelection(
  selected: EntryAttachment[],
  entry: EntryAttachment,
  cap: number,
): EntryAttachment[] {
  const idx = selected.findIndex((a) => a.id === entry.id)
  if (idx >= 0) {
    return [...selected.slice(0, idx), ...selected.slice(idx + 1)]
  }
  if (selected.length >= cap) return selected
  return [...selected, entry]
}
