/**
 * Pure send/replay decision for Daily Chat.
 *
 * SAFETY PROPERTY (RAG Phase 5 oversize gate): this module intentionally
 * accepts **no** preflight / `needsConfirm` argument. The debounced frontend
 * preflight estimate may be null, stale, or wrong at the moment Send is
 * pressed — it must never gate a send. The backend recomputes the plan on
 * every turn and is the only authority that can refuse with
 * `needs_confirmation`. A regression that adds a preflight short-circuit
 * in the component is prevented by keeping the decision here, with tests
 * that pin the no-preflight contract.
 */

export type PendingChatSend<TAttachment> = {
  text: string
  attachments: TAttachment[]
}

export type ChatSendPayload<TAttachment> = {
  text: string
  attachments: TAttachment[]
  /** True on the first attempt (clear composer + stash pending); false on
   *  oversize-confirmed replay (reuse pending, leave composer alone). */
  clearComposer: boolean
}

/**
 * Resolve the text + attachments for a send attempt.
 *
 * Returns `null` when there is nothing to send (empty text, or a turn is
 * already streaming). Does not consult context-size preflight.
 */
export function resolveChatSendPayload<TAttachment>(args: {
  oversizeConfirmed: boolean
  input: string
  pending: PendingChatSend<TAttachment> | null
  attachmentRefs: TAttachment[]
  turnIsStreaming: boolean
}): ChatSendPayload<TAttachment> | null {
  const text = args.oversizeConfirmed ? (args.pending?.text ?? '') : args.input.trim()
  if (!text) return null
  if (args.turnIsStreaming) return null
  const attachments = args.oversizeConfirmed
    ? (args.pending?.attachments ?? [])
    : args.attachmentRefs
  return {
    text,
    attachments,
    clearComposer: !args.oversizeConfirmed,
  }
}
