/**
 * Broadcast to refresh the media gallery cache after media insert/delete.
 *
 * The app-level bridge in src/lib/queryClient.ts listens for this event
 * and invalidates ['media'] queries. Use this from any code path that
 * inserts or deletes a media row (or causes a cascade delete via
 * entry soft-delete).
 */
export function emitMediaChanged(): void {
  window.dispatchEvent(new CustomEvent('memlore:media-changed'))
}

/**
 * Broadcast that a media row's BYTES (thumbnail or full file) just became
 * locally available — typically after `ensureMediaCached` finished a Drive
 * download. Distinct from `media-changed` because the DB row itself did
 * NOT change: only the on-disk cache. The TanStack Query bridge does NOT
 * subscribe to this event, so a download-complete does not trigger a
 * cascade refetch of `['media']` in the gallery (which would otherwise
 * re-run every visible cell's `ensureMediaCached` on every other cell's
 * download — quadratic on a fresh page).
 *
 * Components that hold a stale "cloud-only" render state subscribe to
 * this event so they can re-peek the module cache and hydrate.
 */
export function emitMediaCached(): void {
  window.dispatchEvent(new CustomEvent('memlore:media-cached'))
}
