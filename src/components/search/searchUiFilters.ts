import type { TimeRange } from '../../lib/entryFilterSort'
import type { EmotionKey } from '../../types/entry'

export type HasMediaState = 'any' | 'has' | 'none'

export interface SearchUiFilters {
  range: TimeRange
  journalIds: string[]
  tagIds: string[]
  emotions: EmotionKey[]
  hasMedia: HasMediaState
}

export const defaultSearchUiFilters: SearchUiFilters = {
  range: { kind: 'all' },
  journalIds: [],
  tagIds: [],
  emotions: [],
  hasMedia: 'any',
}

/** True when at least one filter slice is non-default. */
export function hasAnyFilter(f: SearchUiFilters): boolean {
  return (
    f.range.kind !== 'all' ||
    f.journalIds.length > 0 ||
    f.tagIds.length > 0 ||
    f.emotions.length > 0 ||
    f.hasMedia !== 'any'
  )
}
