import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addTagToEntry as tauriAddTagToEntry,
  createTag as tauriCreateTag,
  deleteTag as tauriDeleteTag,
  getTagsWithCounts,
  updateTag as tauriUpdateTag,
} from '../lib/tauri'
import { sortTagsByName } from '../lib/tagPicker'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import type { Tag } from '../types/journal'

const TAGS_CHANGED_EVENT = 'memlore:tags-changed'
const ENTRIES_CHANGED_EVENT = 'memlore:entries-changed'

/** Broadcast that tag list / counts have changed (create, delete, etc).
 * Subscribers (e.g. useTags) refetch. Entries-changed also flows in
 * because per-tag counts depend on non-deleted entries. */
export function emitTagsChanged() {
  window.dispatchEvent(new CustomEvent(TAGS_CHANGED_EVENT))
}

function upsertTagWithCount(rows: Array<[Tag, number]>, tag: Tag): Array<[Tag, number]> {
  const idx = rows.findIndex(([existing]) => existing.id === tag.id)
  if (idx >= 0) {
    const next = [...rows]
    next[idx] = [tag, next[idx][1]]
    return next
  }
  return [...rows, [tag, 0]]
}

/**
 * Assignable tag list + per-tag entry counts from `getTagsWithCounts`.
 * Subscribes to `memlore:tags-changed` and `memlore:entries-changed` so
 * every picker (journal form, editor footer, search filters, Tags view)
 * stays in sync after create/delete/attach anywhere in the app.
 *
 * `tags` is the alphabetically sorted assignable list for suggestion UIs.
 * `tagsWithCounts` keeps count-desc ordering for the Tags management page.
 */
export function useTags() {
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const [tagsWithCounts, setTagsWithCounts] = useState<Array<[Tag, number]>>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const fetched = await getTagsWithCounts(activeVaultId)
      setTagsWithCounts(fetched)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // Drop the previous list — it may include invisible-vault tags that a
      // failed post-lock refetch must not leave visible.
      setTagsWithCounts([])
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [activeVaultId])

  useEffect(() => {
    // Vault opened/closed (fetchAll identity changed): clear synchronously so
    // the vault-scoped list never outlives the vault session while the
    // refetch is in flight.
    setTagsWithCounts([])
    void fetchAll()
    const handler = () => {
      void fetchAll()
    }
    window.addEventListener(TAGS_CHANGED_EVENT, handler)
    window.addEventListener(ENTRIES_CHANGED_EVENT, handler)
    return () => {
      window.removeEventListener(TAGS_CHANGED_EVENT, handler)
      window.removeEventListener(ENTRIES_CHANGED_EVENT, handler)
    }
  }, [fetchAll])

  const tags = useMemo<Tag[]>(
    () => sortTagsByName(tagsWithCounts.map(([row]) => row)),
    [tagsWithCounts],
  )

  const createTag = async (name: string, color?: string): Promise<Tag> => {
    const tag = await tauriCreateTag(name, color)
    setTagsWithCounts((prev) => upsertTagWithCount(prev, tag))
    emitTagsChanged()
    return tag
  }

  const deleteTag = async (id: string): Promise<void> => {
    await tauriDeleteTag(id)
    emitTagsChanged()
  }

  const updateTag = async (
    id: string,
    patch: { name?: string; color?: string | null },
  ): Promise<Tag> => {
    const tag = await tauriUpdateTag(id, patch)
    emitTagsChanged()
    return tag
  }

  const attachTag = async (entryId: string, tagId: string): Promise<void> => {
    await tauriAddTagToEntry(entryId, tagId)
    emitTagsChanged()
  }

  return {
    tags,
    tagsWithCounts,
    isLoading,
    error,
    refresh: fetchAll,
    createTag,
    deleteTag,
    updateTag,
    attachTag,
  }
}
