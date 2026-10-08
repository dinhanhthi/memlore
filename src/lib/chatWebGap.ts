/**
 * Why the web build could not show every chat, memory or persona row: a
 * desktop's synced bin was too large to download or could not be read.
 * The UI then points the user to the desktop app instead of showing nothing.
 */
export type ChatWebGap = 'too_large_for_web' | 'unreadable_on_web'

/** Optional flags the web backend adds to a result whose merge is incomplete. */
export interface WebGapFlags {
  tooLargeForWeb?: boolean
  unreadableOnWeb?: boolean
}

export function chatWebGapOf(flags: WebGapFlags | null | undefined): ChatWebGap | null {
  if (flags?.tooLargeForWeb === true) return 'too_large_for_web'
  if (flags?.unreadableOnWeb === true) return 'unreadable_on_web'
  return null
}

/** The gap a `daily_chat_load_session` rejection names, or null for any other error. */
export function chatWebGapFromError(e: unknown): ChatWebGap | null {
  const text = e instanceof Error ? e.message : String(e)
  if (text.includes('too_large_for_web')) return 'too_large_for_web'
  if (text.includes('unreadable_on_web')) return 'unreadable_on_web'
  return null
}
