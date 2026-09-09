import { useState, useEffect, useCallback } from 'react'
import { collectEntryExifDates } from '../lib/tauri'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SuggestionState =
  | { kind: 'none' }
  | { kind: 'single'; date: number }
  | { kind: 'multi'; dates: number[] }

interface UseEntryDateSuggestionOptions {
  /** The entry whose attached images are inspected. Null = no-op. */
  entryId: string | null
  /**
   * When true the suggestion is always suppressed — the user has already
   * made an explicit date choice for this entry and should not be bothered
   * again even if more images are added.
   */
  entryDateUserEdited: boolean
}

interface UseEntryDateSuggestionResult {
  suggestion: SuggestionState
  /**
   * Call after adding one or more images to the entry.
   * Re-queries `collect_entry_exif_dates` and refreshes `suggestion`.
   *
   * Resolves once the new suggestion state has been applied. Callers that
   * surface a "saving photo" spinner can `await` this to keep the spinner
   * visible until the suggestion modal (if any) is ready to render — so
   * the user never sees a gap between spinner-off and modal-on.
   */
  triggerCheck: () => Promise<void>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Inspects the EXIF dates of all images attached to `entryId` and returns a
 * suggestion state for the multi-EXIF date picker UI:
 *
 * - `none`   → no EXIF dates found, or user has already edited the date
 * - `single` → exactly one distinct UTC day across all images
 * - `multi`  → two or more distinct UTC days across all images
 *
 * The hook is intentionally non-reactive: it only queries on mount and when
 * `triggerCheck()` is called explicitly (after a pick/paste operation). It
 * does not poll — the Editor calls `triggerCheck` after each image is saved.
 */
export function useEntryDateSuggestion({
  entryId,
  entryDateUserEdited,
}: UseEntryDateSuggestionOptions): UseEntryDateSuggestionResult {
  const [suggestion, setSuggestion] = useState<SuggestionState>({ kind: 'none' })

  const triggerCheck = useCallback(async () => {
    if (!entryId || entryDateUserEdited) {
      setSuggestion({ kind: 'none' })
      return
    }
    try {
      const dates = await collectEntryExifDates(entryId)
      if (dates.length === 0) {
        setSuggestion({ kind: 'none' })
      } else if (dates.length === 1) {
        setSuggestion({ kind: 'single', date: dates[0] })
      } else {
        setSuggestion({ kind: 'multi', dates })
      }
    } catch {
      setSuggestion({ kind: 'none' })
    }
  }, [entryId, entryDateUserEdited])

  // Initial fetch on mount / entryId change. Also re-runs when the
  // user-edited flag flips back to false (e.g. opening a fresh entry).
  useEffect(() => {
    void triggerCheck()
  }, [triggerCheck])

  return { suggestion, triggerCheck }
}
