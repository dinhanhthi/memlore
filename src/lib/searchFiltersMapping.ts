import type { SearchFilters, EmotionKey } from '../types/entry'
import { timeRangeBounds } from './entryFilterSort'
import type { SearchUiFilters } from '../components/search/searchUiFilters'

/** Convert UI-level filter state to the backend wire shape.
 *
 * Empty arrays + `kind: 'all'` + `hasMedia: 'any'` are dropped (field
 * omitted) so the backend receives `None` for each unused dimension —
 * keeping the IPC payload small and the Rust `is_empty()` check accurate.
 *
 * Returns `undefined` when the entire filter state is at defaults so
 * callers can skip sending the `filters` argument altogether. */
export function mapSearchFilters(ui: SearchUiFilters): SearchFilters | undefined {
  const out: SearchFilters = {}

  if (ui.range.kind !== 'all') {
    const bounds = timeRangeBounds(ui.range)
    if (bounds) {
      out.timeRange = { from: bounds.from, toExclusive: bounds.toExclusive }
    }
  }
  if (ui.journalIds.length > 0) out.journalIds = ui.journalIds
  if (ui.tagIds.length > 0) out.tagIds = ui.tagIds
  if (ui.emotions.length > 0) out.emotions = ui.emotions as EmotionKey[]
  if (ui.hasMedia !== 'any') out.hasMedia = ui.hasMedia

  return Object.keys(out).length === 0 ? undefined : out
}
