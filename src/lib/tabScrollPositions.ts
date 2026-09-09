/** Session-only scroll positions keyed by tab + view. Not persisted. */

const positions = new Map<string, number>()

export function tabScrollKey(tabId: string, view: string, sub?: string): string {
  return sub == null || sub === '' ? `${tabId}:${view}` : `${tabId}:${view}:${sub}`
}

export function getTabScroll(key: string): number | undefined {
  return positions.get(key)
}

export function setTabScroll(key: string, top: number): void {
  positions.set(key, top)
}

/** Clear one key, or the whole map when `key` is omitted (tests). */
export function clearTabScroll(key?: string): void {
  if (key === undefined) {
    positions.clear()
    return
  }
  positions.delete(key)
}

/** False when the port is `display:none` or has no box — do not save/restore. */
export function isScrollPortUsable(el: HTMLElement): boolean {
  if (el.clientHeight <= 0) return false
  if (typeof window !== 'undefined' && window.getComputedStyle(el).display === 'none') {
    return false
  }
  return true
}

/**
 * Apply `saved` if the port is visible and tall enough.
 * Returns false when the caller should retry later (hidden or not yet tall).
 * Does not write `scrollTop` on failure, so a 0-height clamp cannot clobber.
 */
export function applySavedScroll(el: HTMLElement, saved: number): boolean {
  if (!isScrollPortUsable(el)) return false
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
  if (saved > maxScroll) return false
  el.scrollTop = saved
  return true
}
