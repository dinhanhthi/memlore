/**
 * Pure resolver for the Daily Chat "Save as entry" / "Update the entry"
 * button state (Daily Chat ⇄ Entry link, Phase 3 Task T1).
 *
 * Kept free of React and any side effects on purpose: the component
 * (`ChatConversation.tsx`) feeds it session facts and renders from the
 * result. Keeping it pure means the whole truth table is exercisable in a
 * `.test.ts` (project rule: no `.test.tsx` component tests).
 *
 * Streaming convention: when `isStreaming` is true the spec wants the
 * `save`/`update` buttons to stay their kind but render disabled. Rather
 * than push that into a separate flag the consumer has to remember, every
 * non-hidden variant carries its own `enabled` boolean so the component
 * can spread it straight onto the button:
 *   - `save` / `update`: `enabled = !isStreaming`
 *   - `update-disabled`: `enabled = false` always (it represents "entry is
 *     already up to date", which is disabled regardless of streaming).
 * `hidden` carries no `enabled` field because it renders no button at all.
 */
export type EntryButtonState =
  | { kind: 'hidden' }
  | { kind: 'save'; enabled: boolean }
  | { kind: 'update'; enabled: boolean }
  | { kind: 'update-disabled'; enabled: boolean }

export interface EntryButtonInput {
  /** True if there is at least one non-streaming assistant message. */
  hasNonStreamingAssistant: boolean
  /** True if the chat is currently streaming a reply. */
  isStreaming: boolean
  /** The session's convertedEntryId (null = never converted). */
  convertedEntryId: string | null
  /** True if an assistant message arrived after the conversion watermark. */
  newSinceConversion: boolean
}

/**
 * Resolve the entry-button state from session facts.
 *
 * Truth table:
 *   convertedEntryId == null && !hasNonStreamingAssistant -> hidden
 *   convertedEntryId == null &&  hasNonStreamingAssistant -> save
 *   convertedEntryId != null &&  newSinceConversion       -> update
 *   convertedEntryId != null && !newSinceConversion       -> update-disabled
 *
 * Streaming flips `enabled` on `save`/`update` to false but never changes
 * the `kind`; `update-disabled` is always disabled.
 */
export function resolveEntryButtonState(input: EntryButtonInput): EntryButtonState {
  const { hasNonStreamingAssistant, isStreaming, convertedEntryId, newSinceConversion } = input

  if (convertedEntryId == null) {
    if (!hasNonStreamingAssistant) return { kind: 'hidden' }
    return { kind: 'save', enabled: !isStreaming }
  }

  if (newSinceConversion) {
    return { kind: 'update', enabled: !isStreaming }
  }

  return { kind: 'update-disabled', enabled: false }
}
