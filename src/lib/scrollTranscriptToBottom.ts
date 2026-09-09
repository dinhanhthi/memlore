/** Distance (px) under which follow-mode treats the user as “near bottom”. */
export const NEAR_BOTTOM_THRESHOLD_PX = 120

export type ScrollTranscriptMode = 'force' | 'if-near-bottom'

export interface ScrollTranscriptOptions {
  mode: ScrollTranscriptMode
  /** When true, use smooth scrolling; when false, jump instantly. */
  smooth: boolean
  threshold?: number
}

export interface ResolveTranscriptScrollModeInput {
  pendingForce: boolean
  /** Sticky bottom after the user sends — stays force through the reply stream. */
  pinToBottom: boolean
  messageCount: number
}

export interface ResolveTranscriptScrollModeResult {
  /** `null` = skip scrolling this turn (e.g. still waiting for history). */
  mode: ScrollTranscriptMode | null
  clearPending: boolean
}

/**
 * Decide scroll mode for a transcript update.
 *
 * When a session was just selected (`pendingForce`), wait until at least one
 * message is present so we don't burn the force-scroll on the empty
 * placeholder render before history loads. Empty sessions keep the pending
 * flag until the first message arrives.
 *
 * `pinToBottom` covers “user just sent” — force-scroll even if they had
 * scrolled up, and keep forcing while the assistant reply streams.
 */
export function resolveTranscriptScrollMode(
  input: ResolveTranscriptScrollModeInput,
): ResolveTranscriptScrollModeResult {
  if (input.pendingForce) {
    if (input.messageCount === 0) {
      return { mode: null, clearPending: false }
    }
    return { mode: 'force', clearPending: true }
  }
  if (input.pinToBottom) {
    return { mode: 'force', clearPending: false }
  }
  return { mode: 'if-near-bottom', clearPending: false }
}

/**
 * Decide whether the transcript container should scroll to the latest
 * message. `force` always scrolls (session select); `if-near-bottom`
 * only follows when the user hasn't scrolled away.
 */
export function shouldScrollTranscriptToBottom(
  el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  mode: ScrollTranscriptMode,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  if (mode === 'force') return true
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  return distanceFromBottom < threshold
}

/**
 * Scroll a chat transcript container to the latest message.
 *
 * Returns whether a scroll was performed. Uses `scrollTo` on the
 * explicit container only (never `scrollIntoView`) so WKWebView cannot
 * bubble the scroll up to `<html>` / TitleBar.
 */
export function scrollTranscriptToBottom(el: HTMLElement, opts: ScrollTranscriptOptions): boolean {
  if (!shouldScrollTranscriptToBottom(el, opts.mode, opts.threshold)) return false
  el.scrollTo({
    top: el.scrollHeight,
    behavior: opts.smooth ? 'smooth' : 'auto',
  })
  return true
}
