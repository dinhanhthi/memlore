import { useState, useEffect, useCallback } from 'react'
import { listMediaForEntry } from '../lib/tauri'
import type { MediaRow } from '../lib/tauri'
import { ensureMediaCached } from '../components/media/mediaCache'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

interface UseEntryAttachmentsResult {
  attachments: MediaRow[]
  refetch: () => void
  isLoading: boolean
}

/**
 * Returns all media rows (both `insertion_mode = 'inline'` and
 * `insertion_mode = 'attached'`) for the given entry. Re-fetches automatically
 * when `entryId` changes.
 *
 * Returns an empty array immediately (with no Tauri call) when `entryId` is
 * `undefined`.
 */
export function useEntryAttachments(entryId: string | undefined): UseEntryAttachmentsResult {
  const [attachments, setAttachments] = useState<MediaRow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)

  const refetch = useCallback(() => {
    setTick((t) => t + 1)
  }, [])

  useEffect(() => {
    if (!entryId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch reset; would need TanStack Query to fix properly
      setAttachments([])
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)

    listMediaForEntry(entryId, undefined, activeVaultId)
      .then((rows) => {
        if (cancelled) return
        setAttachments(rows)
        setIsLoading(false)
        // Auto-download trigger for every attached media row.
        // - Inline images need the FULL bytes (the editor renders them
        //   at intrinsic size, no thumbnail substitute is acceptable).
        // - Attached items get BOTH: the thumbnail (so the 64×64 strip
        //   cell renders immediately) AND the full bytes (so opening
        //   the lightbox doesn't show "Tap to download"). The two
        //   ensureMediaCached calls are independent + idempotent.
        // - Audio has no thumbnail file — only the full file applies.
        // ensureMediaCached is idempotent + deduped; calling it for
        // already-local rows is essentially free.
        for (const row of rows) {
          const isAudio = row.file_type.startsWith('audio/')
          if (isAudio) {
            void ensureMediaCached(row.id, false)
            continue
          }
          // Always fetch the full bytes (used by lightbox + inline editor).
          void ensureMediaCached(row.id, false)
          // For attachments, also fetch the thumbnail so the 64×64
          // strip cell hydrates without waiting for the full file.
          if (row.insertion_mode === 'attached') {
            void ensureMediaCached(row.id, true)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAttachments([])
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [entryId, activeVaultId, tick])

  return { attachments, refetch, isLoading }
}
