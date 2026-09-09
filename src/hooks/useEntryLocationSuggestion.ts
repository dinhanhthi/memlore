import { useState, useEffect, useCallback } from 'react'
import { collectEntryExifLocations } from '../lib/tauri'
import type { ExifLocation } from '../lib/tauri'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SuggestionState =
  | { kind: 'none' }
  | { kind: 'single'; location: ExifLocation }
  | { kind: 'multi'; locations: ExifLocation[] }

interface UseEntryLocationSuggestionOptions {
  /** The entry whose attached images are inspected. Null = no-op. */
  entryId: string | null
  /**
   * When true the suggestion is always suppressed — the user has already
   * made an explicit location choice for this entry and should not be bothered
   * again even if more images are added.
   */
  entryLocationUserEdited: boolean
}

interface UseEntryLocationSuggestionResult {
  suggestion: SuggestionState
  /**
   * Resolves once the new suggestion state has been applied. Callers that
   * surface a "saving photo" spinner can `await` this so the spinner stays
   * up until the modal (if any) is ready to render.
   */
  triggerCheck: () => Promise<void>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Inspects the EXIF GPS locations of all images attached to `entryId` and
 * returns a suggestion state for the location picker UI:
 *
 * - `none`   → no EXIF locations found, or user has already edited the location
 * - `single` → exactly one distinct GPS coordinate across all images
 * - `multi`  → two or more distinct GPS coordinates across all images
 *
 * The hook is intentionally non-reactive: it only queries on mount and when
 * `triggerCheck()` is called explicitly (after a pick/paste operation). It
 * does not poll — the Editor calls `triggerCheck` after each image is saved.
 */
export function useEntryLocationSuggestion({
  entryId,
  entryLocationUserEdited,
}: UseEntryLocationSuggestionOptions): UseEntryLocationSuggestionResult {
  const [suggestion, setSuggestion] = useState<SuggestionState>({ kind: 'none' })

  const triggerCheck = useCallback(async () => {
    if (!entryId || entryLocationUserEdited) {
      setSuggestion({ kind: 'none' })
      return
    }
    try {
      const locations = await collectEntryExifLocations(entryId)
      if (locations.length === 0) {
        setSuggestion({ kind: 'none' })
      } else if (locations.length === 1) {
        setSuggestion({ kind: 'single', location: locations[0] })
      } else {
        setSuggestion({ kind: 'multi', locations })
      }
    } catch {
      setSuggestion({ kind: 'none' })
    }
  }, [entryId, entryLocationUserEdited])

  // Initial fetch on mount / entryId change. Also re-runs when the
  // user-edited flag flips back to false (e.g. opening a fresh entry).
  useEffect(() => {
    void triggerCheck()
  }, [triggerCheck])

  return { suggestion, triggerCheck }
}
