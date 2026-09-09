import type { ActiveView } from '../stores/uiStore'

/** Views where the editor column is hidden — distraction shell only applies outside these. */
export const EDITOR_FULL_WIDTH_VIEWS = new Set<ActiveView>([
  'settings',
  'stats',
  'chat',
  'map',
  'about',
  'dashboard',
])

/** True when distraction mode should hide the sidebar and entry-list shell. */
export function isEditorDistractionShellActive(
  distractionMode: boolean,
  selectedEntryId: string | null,
  activeView: ActiveView,
): boolean {
  return distractionMode && selectedEntryId != null && !EDITOR_FULL_WIDTH_VIEWS.has(activeView)
}
