/**
 * Synchronous flag the global ⌘F keydown handler reads to decide whether to
 * swallow the chord (in favor of the in-editor find UI) or let the browser's
 * native Find handle it. Set by `EditorPanel` on mount/unmount in Phase 4.
 * Until Phase 4 ships, the flag stays false and ⌘F falls through to native
 * Find everywhere.
 */

let mountCount = 0

/** Mark an editor as mounted (true) or unmounted (false). */
export function setEditorMounted(mounted: boolean): void {
  mountCount += mounted ? 1 : -1
  if (mountCount < 0) mountCount = 0 // defensive — shouldn't happen but cap at zero
}

/** Returns true when a TipTap editor is currently mounted in the UI. */
export function isEditorMounted(): boolean {
  return mountCount > 0
}

/**
 * More than one `EditorPanel` instance can be mounted at once — the main
 * panel and the map overlay in `LocationsMapView` both render one, gated on
 * mutually-exclusive `activeView` values today, but nothing enforces that
 * invariant at the type level. Window events that must be handled by
 * exactly one mounted instance (e.g. the version-history restore listener)
 * use this registry to pick a single owner: whichever instance mounted
 * most recently wins, mirroring "the panel for the current view" without
 * relying on DOM focus (the restore target may not be focused, or even
 * open, yet).
 */
let activeEditorInstanceId = 0
let nextEditorInstanceId = 0

/** Register a newly-mounted EditorPanel instance as the active one. Call
 *  once per mount and keep the returned id to check ownership later. */
export function registerActiveEditorInstance(): number {
  nextEditorInstanceId += 1
  activeEditorInstanceId = nextEditorInstanceId
  return activeEditorInstanceId
}

/** Whether `id` (from `registerActiveEditorInstance`) is still the most
 *  recently mounted EditorPanel instance. */
export function isActiveEditorInstance(id: number): boolean {
  return id === activeEditorInstanceId
}
