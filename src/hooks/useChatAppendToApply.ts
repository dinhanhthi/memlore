import { useEffect, useRef, useState } from 'react'

import { useChatDraftStore } from '../stores/chatDraftStore'

/** The append handoff to feed into `<Editor initialChatAppendHtml={…} />`. */
type ChatAppend = { id: string; html: string }

/**
 * Pure consume-or-restore step, extracted so the StrictMode-safety invariant
 * can be unit-tested deterministically (the vitest env does not double-invoke
 * StrictMode effects, so a `renderHook` wrapper can't reproduce the race).
 *
 * First call for a nonce: `consume()` returns the value, cache it in `ref`.
 * Second call for the SAME nonce (the StrictMode re-invoke, where the store key
 * is already deleted so `consume()` would return null): the ref matches, so we
 * skip the consume and return the cached value — the restore that prevents the
 * silent drop. Returns `null` only when there is genuinely nothing to apply.
 */
export function resolvePendingAppend(
  ref: { current: ChatAppend | null },
  pendingAppend: ChatAppend | undefined,
  consume: () => ChatAppend | null,
): ChatAppend | null {
  if (!pendingAppend) return null
  if (ref.current?.id !== pendingAppend.id) {
    const consumed = consume()
    if (!consumed) return null
    ref.current = consumed
  }
  return ref.current
}

/**
 * Drains the Daily Chat "Update the entry" append queue for `entryId` and
 * returns the `{ id, html }` to apply to the editor exactly once (or `null`).
 *
 * Unlike the "Save as entry" seed (consumed once during the entry-load effect),
 * this is REACTIVE: it selects `pendingAppendByEntryId[entryId]` from the store
 * so it re-fires whenever a NEW append is enqueued for the currently-open entry
 * — even if the entry was already open when the enqueue happened.
 *
 * StrictMode-safety is the tricky part and the reason this lives in its own
 * hook with a dedicated test. On a fresh mount (which happens every time the
 * user returns from a full-width view like Daily Chat — see
 * `EDITOR_FULL_WIDTH_VIEWS`), React StrictMode runs the effects
 * mount → cleanup → mount. The entryId-keyed reset below nulls the value
 * between the two passes, and `consumePendingChatAppend` is destructive
 * (deletes the store key), so the second pass's consume returns `null`.
 * Without a cached copy the append would be silently dropped. So the consumed
 * value is cached in a nonce-keyed ref and the second-pass re-run of the
 * consume effect restores it (React runs all cleanups before all re-creates,
 * so the restore lands after the reset's null).
 *
 * The ref is keyed by NONCE, not `entryId`, and is NEVER cleared on purpose:
 * clearing it in any cleanup would run between the two StrictMode mount passes
 * and re-break the recovery; a UUID nonce can't collide across entries, so an
 * entryId key would add nothing.
 */
export function useChatAppendToApply(entryId: string | null): ChatAppend | null {
  const pendingAppend = useChatDraftStore((s) =>
    entryId ? s.pendingAppendByEntryId[entryId] : undefined,
  )
  const [appendToApply, setAppendToApply] = useState<ChatAppend | null>(null)
  const consumedAppendRef = useRef<ChatAppend | null>(null)

  useEffect(() => {
    const next = resolvePendingAppend(consumedAppendRef, pendingAppend, () =>
      entryId ? useChatDraftStore.getState().consumePendingChatAppend(entryId) : null,
    )
    // Only ever SET a real value here; nulling is the reset effect's job (so a
    // failed/duplicate consume can't wipe a queued-but-unapplied append).
    if (next) setAppendToApply(next)
  }, [entryId, pendingAppend])

  // Reset ONLY when the open entry actually changes — keyed on `entryId` alone,
  // deliberately NOT folded into the caller's entry-load effect (whose deps
  // also include `revealInvisible`/`updateActiveTab`). That separation is
  // load-bearing: (1) leaving an entry must clear the append so it isn't
  // re-applied when the SAME entry is reopened — switching E→F→E remounts
  // `<Editor/>` and resets its nonce guard, which would otherwise duplicate it;
  // (2) but a `revealInvisible` toggle mid-flow must NOT clear it (the consume
  // effect wouldn't re-run to restore from the cache, and the store key is
  // already consumed → unrecoverable loss). This effect fires on neither of
  // those unrelated deps, closing that window.
  useEffect(() => {
    return () => setAppendToApply(null)
  }, [entryId])

  return appendToApply
}
