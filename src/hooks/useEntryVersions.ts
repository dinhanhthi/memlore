import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listEntryVersions, getEntryVersionContent } from '../lib/tauri'
import type { VersionMeta } from '../lib/tauri'
import { emitRestoreEntryVersion, type EntryVersionsChangedDetail } from '../lib/versionEvents'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

export interface UseEntryVersionsResult {
  versions: VersionMeta[]
  isLoading: boolean
  error: string | null
  /** Fetch the raw Yjs bytes for a version, for read-only preview. */
  getVersionContent: (versionId: string) => Promise<Uint8Array>
  /**
   * Request a CRDT-safe restore of `versionId` into `entryId`. Does not
   * mutate anything itself — emits `memlore:restore-entry-version`, which
   * `EditorPanel` handles by applying the version via the live editor's
   * `setContent`, never by overwriting the stored `yjs_doc` blob.
   */
  restore: (versionId: string) => void
}

/**
 * List + preview + restore for an entry's version history. Mirrors the
 * `useEntries.ts` pattern: a React Query list keyed by entry id, plus a
 * window-event bridge (`memlore:entry-versions-changed`) so a
 * session-snapshot taken elsewhere (EditorPanel) invalidates this list
 * without a manual refetch call.
 */
export function useEntryVersions(entryId: string | null): UseEntryVersionsResult {
  const queryClient = useQueryClient()
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const queryKey = ['entry-versions', entryId, activeVaultId] as const

  const query = useQuery<VersionMeta[]>({
    queryKey,
    queryFn: () => listEntryVersions(entryId as string, activeVaultId),
    enabled: entryId !== null,
  })

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<EntryVersionsChangedDetail>).detail
      if (!detail || detail.entryId !== entryId) return
      void queryClient.invalidateQueries({ queryKey: ['entry-versions', entryId] })
    }
    window.addEventListener('memlore:entry-versions-changed', handler as EventListener)
    return () =>
      window.removeEventListener('memlore:entry-versions-changed', handler as EventListener)
  }, [entryId, queryClient])

  const getVersionContent = useCallback(
    async (versionId: string): Promise<Uint8Array> => {
      if (!entryId) throw new Error('getVersionContent: no entryId')
      const bytes = await getEntryVersionContent(versionId, entryId, activeVaultId)
      return new Uint8Array(bytes)
    },
    [entryId, activeVaultId],
  )

  const restore = useCallback(
    (versionId: string) => {
      if (!entryId) return
      emitRestoreEntryVersion(entryId, versionId)
    },
    [entryId],
  )

  return {
    versions: query.data ?? [],
    isLoading: query.isPending,
    error: query.error ? String(query.error) : null,
    getVersionContent,
    restore,
  }
}
