/** Items per page across every paginated surface. Must match
 *  `PAGE_SIZE` in `src-tauri/src/db/paging.rs`. */
export const PAGE_SIZE = 20

export interface PagedResult<T> {
  items: T[]
  total: number
}

export type EntrySort = 'newest' | 'oldest' | 'recentlyEdited'
export type EntryTimeRange = 'all' | 'today' | 'thisWeek' | 'thisMonth' | 'thisYear'
export type LockFilter = 'all' | 'secondLocked' | 'invisibleLocked'

export type PaginatedViewKey =
  | 'all'
  | `favorites:${string}` // per-journal scope: ${journalId} or 'all'
  | `journal:${string}`
  | `tag:${string}`
  | 'media'
  | 'chat-sessions'
  | 'ask-journal-queries'
