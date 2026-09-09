import type { RestoreEntryVersionDetail } from './versionEvents'

/**
 * Module-level singleton holding a not-yet-applied version restore request.
 *
 * Deliberately NOT React component state (e.g. a `useRef` inside
 * `EditorPanel`): restoring a version for an entry that isn't the currently
 * active editor can flip `activeView` (e.g. away from the map view), which
 * unmounts the map overlay's `EditorPanel` instance entirely and mounts a
 * fresh main `EditorPanel` instance in its place. A per-instance ref set by
 * the overlay would be destroyed along with it and never reach the new
 * instance. This singleton lives outside any component's lifecycle, so it
 * survives that unmount/mount handoff.
 */
let pendingRestore: RestoreEntryVersionDetail | null = null

export function setPendingRestore(detail: RestoreEntryVersionDetail | null): void {
  pendingRestore = detail
}

export function getPendingRestore(): RestoreEntryVersionDetail | null {
  return pendingRestore
}
