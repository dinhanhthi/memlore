import { useEffect, useState } from 'react'
import { chatRagPreflight } from '../lib/tauri'
import type { ChatAttachmentRef, ChatContextPreflight } from '../types/ai'

const DEBOUNCE_MS = 250

/**
 * Debounced, display-only preflight estimate for the context a Daily Chat
 * turn would inject. Feeds the always-visible size readout — it is never a
 * gate on whether a send proceeds (that lives server-side in
 * `daily_chat_send_turn`, see README decision 17), because this value is
 * debounced and may be null, stale, or errored at the moment Send is pressed.
 */
export function useChatContextPreflight(
  attachments: ChatAttachmentRef[],
  question: string,
  ragEnabled: boolean,
): { preflight: ChatContextPreflight | null; loading: boolean } {
  const [preflight, setPreflight] = useState<ChatContextPreflight | null>(null)
  const [loading, setLoading] = useState(false)

  // A caller may pass a fresh array literal on every render even when its
  // content hasn't changed (e.g. built from component state via `.map`).
  // Keying the effect on content rather than reference — the same
  // `idsKey` technique `useEntryTitles` uses — keeps the debounce timer
  // from being torn down and restarted on every render.
  const attachmentsKey = JSON.stringify(attachments)

  useEffect(() => {
    const currentAttachments: ChatAttachmentRef[] = JSON.parse(attachmentsKey)

    if (currentAttachments.length === 0 && !ragEnabled) {
      setPreflight(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const handle = setTimeout(() => {
      chatRagPreflight(currentAttachments, question)
        .then((result) => {
          if (cancelled) return
          setPreflight(result)
          setLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          setPreflight(null)
          setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [attachmentsKey, question, ragEnabled])

  return { preflight, loading }
}
