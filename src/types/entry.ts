/** 3-state emotion key matching the backend constraint in
 * `db::queries::update_entry_emotion`. Anything else is rejected at
 * the DB layer. */
export type EmotionKey = 'bad' | 'neutral' | 'good'

export interface Entry {
  id: string
  journal_id: string
  title: string | null
  preview_text: string | null
  content_text: string | null
  entry_date: number
  created_at: number
  updated_at: number
  latitude: number | null
  longitude: number | null
  location_label: string | null
  location_address: string | null
  weather_summary: string | null
  weather_icon: string | null
  emotion: EmotionKey | null
  is_favorite: boolean
  is_deleted: boolean
  is_locked: boolean
  is_invisible: boolean
  /** Owning invisible vault when invisible; null when visible. Multi-vault
   * ownership — filter rewrite lands later; column is projected now. */
  vault_id: string | null
  cover_media_id: string | null
  /** ISO 639-1 (or 639-3 fallback) language tag — populated by the
   * Phase 6 A5 auto-detect hook on first save, or set manually via
   * the language pill. NULL = never tagged. */
  content_language: string | null
  /** Durable flag: true once the user has finalized the entry's date
   * (manual edit, EXIF-suggestion confirm, or modal dismiss). The
   * frontend reads this to suppress the multi-EXIF date modal across
   * entry navigation. Fresh entries default to false so EXIF
   * suggestions still fire on first insert. */
  entry_date_user_edited: boolean
  /** Denormalized count of media rows for this entry (images, videos, audio). */
  media_count: number
  /** True if this entry was created by converting a daily chat session.
   * Set only by the chat→entry conversion path; lets the entry-list card
   * show a chat-origin indicator without a per-card back-ref lookup.
   * Local-only UX flag — not synced. */
  from_chat: boolean
}

export interface SearchResult {
  id: string
  journal_id: string
  title: string | null
  preview_text: string | null
  entry_date: number
}

/// One match returned by `semantic_search`. `score` is cosine similarity
/// in [-1.0, 1.0]; higher is better. Snippet is plaintext (already not
/// encrypted, same as `content_text`).
export interface SemanticHit {
  entry_id: string
  title: string | null
  snippet: string | null
  score: number
  entry_date: number
}

/** One emotion suggestion from the AI prototype-similarity ranker.
 * `emotion` is one of the 3 polar keys (`bad | neutral | good`).
 * `score` is cosine similarity in `[-1.0, 1.0]`. */
export interface EmotionScore {
  emotion: EmotionKey
  score: number
}

export interface CreateEntryParams {
  journal_id: string
  title?: string
  content_text?: string
  preview_text?: string
  entry_date: number
}

/** Filter parameters for `search_entries` and `semantic_search`.
 * All fields optional: when a field is `undefined` or an empty array
 * it is treated as "no filter for this dimension". The backend's
 * `SearchFilters::is_empty()` handles the same semantics. */
export interface SearchFilters {
  timeRange?: { from: number; toExclusive: number }
  journalIds?: string[]
  tagIds?: string[]
  emotions?: EmotionKey[]
  hasMedia?: 'has' | 'none'
}
