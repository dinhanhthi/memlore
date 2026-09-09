/**
 * Helpers for the Settings → Memories page (ai-user-memory Phase 5 T5.3).
 *
 * Kept in `lib/` so the settings component stays presentational — the
 * timestamp formatter is locale-aware and reusable. `errMsg` is re-exported
 * from `./errMsg` so existing importers keep working.
 */

export { errMsg } from './errMsg'

/**
 * Fold text for fuzzy comparison (same contract as chat-session search and
 * Google Fonts catalog search in Rust): lowercase + strip diacritics.
 *
 * Vietnamese `đ`/`Đ` does not decompose under NFD, so it is mapped to `d`
 * explicitly. Combining marks (U+0300–U+036F) are dropped after NFD.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
}

/**
 * Length of the tightest window in `haystack` that contains `needle` as a
 * subsequence (first match char → last match char, inclusive). `null` when
 * no subsequence exists. Both strings must already be normalized.
 */
export function tightestSubsequenceSpan(needle: string, haystack: string): number | null {
  if (needle.length === 0) return 0
  if (haystack.length === 0) return null

  // Greedy left-to-right first match, then walk needle right-to-left from
  // that end to shrink the start — classic O(n) tightest-window trick for
  // ordered subsequence when we only need one window (not all occurrences).
  let end = -1
  let ni = 0
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] === needle[ni]) {
      ni += 1
      if (ni === needle.length) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null

  let start = end
  ni = needle.length - 1
  for (let i = end; i >= 0; i--) {
    if (haystack[i] === needle[ni]) {
      ni -= 1
      if (ni < 0) {
        start = i
        break
      }
    }
  }
  return end - start + 1
}

/**
 * Whether one already-normalized token fuzzy-matches the haystack.
 *
 * - Contiguous substring always matches.
 * - Tokens shorter than 3 chars require contiguous match (avoids `"te"` /
 *   `"tea"` lighting up half the list via sparse subsequence).
 * - Longer tokens allow non-contiguous subsequence when the tightest
 *   matching span stays within ~2× the token length (abbreviations like
 *   `"mrng"` → morning, while rejecting span-across-sentence noise).
 */
export function fuzzyTokenMatches(token: string, haystack: string): boolean {
  if (token.length === 0) return true
  if (haystack.includes(token)) return true
  if (token.length < 3) return false

  const span = tightestSubsequenceSpan(token, haystack)
  if (span == null) return false
  const maxSpan = Math.max(token.length + 2, Math.ceil(token.length * 2))
  return span <= maxSpan
}

/**
 * Client-side fuzzy filter for the Memories manage modal.
 *
 * All items are already loaded via `list_memory_items`, so search stays
 * local (no backend round-trip). Blank / whitespace-only queries return
 * the full list. Non-empty queries:
 *   1. Diacritic-fold + lowercase (Vietnamese-friendly).
 *   2. Split on whitespace; every token must fuzzy-match (AND).
 *   3. Per token: contiguous substring, or tight subsequence for len ≥ 3
 *      (e.g. `"mrng"` → morning, `"da nang"` → Đà Nẵng).
 *
 * Results keep the input order (already sorted by the list command).
 */
export function filterMemoryItemsByQuery<T extends { text: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const tokens = normalizeSearchText(query.trim())
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return items.slice()
  return items.filter((item) => {
    const hay = normalizeSearchText(item.text)
    return tokens.every((token) => fuzzyTokenMatches(token, hay))
  })
}

/** Format a unix-seconds timestamp as a locale-aware relative "last scanned"
 *  label (e.g. "just now", "3 min ago", "2 hours ago"). Returns an empty
 *  string for non-finite input. Uses `Intl.RelativeTimeFormat` with the
 *  user's UI language, falling back to the runtime default locale. */
export function formatLastScanned(unixSeconds: number, language: string): string {
  if (!Number.isFinite(unixSeconds)) return ''
  const nowSec = Math.floor(Date.now() / 1000)
  const diffSec = nowSec - unixSeconds
  if (diffSec < 60) {
    // Close enough to "now" — Intl.RelativeTimeFormat would emit "0 seconds
    // ago" which reads worse than a fixed phrase. The caller localises via
    // the `last_scanned` key's `{{when}}` interpolation; this is the `when`.
    return new Intl.RelativeTimeFormat(language || undefined, { numeric: 'auto' }).format(
      0,
      'second',
    )
  }
  const rtf = new Intl.RelativeTimeFormat(language || undefined, { numeric: 'auto' })
  const absSec = Math.abs(diffSec)
  if (absSec < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute')
  if (absSec < 86400) return rtf.format(-Math.round(diffSec / 3600), 'hour')
  return rtf.format(-Math.round(diffSec / 86400), 'day')
}
