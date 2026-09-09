import { useEffect, useState } from 'react'
import { getEntry } from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

const ENTRIES_CHANGED_EVENT = 'memlore:entries-changed'

export type EntryTitleLookup = ReadonlyMap<string, string | null>

/**
 * Resolve display titles for a set of entry IDs (e.g. chat source chips).
 * `null` means the entry exists but has no title; a missing map key means not
 * loaded yet or the entry was not found.
 */
export function useEntryTitles(entryIds: string[]): {
  titles: EntryTitleLookup
  loading: boolean
} {
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const [titles, setTitles] = useState<EntryTitleLookup>(new Map())
  const [loading, setLoading] = useState(false)

  const idsKey = [...new Set(entryIds)].sort().join('\0')

  useEffect(() => {
    const uniqueIds = idsKey.length > 0 ? idsKey.split('\0') : []
    if (uniqueIds.length === 0) {
      setTitles(new Map())
      setLoading(false)
      return
    }

    let cancelled = false
    let generation = 0

    const fetchTitles = async () => {
      const currentGeneration = ++generation
      setLoading(true)

      const pairs = await Promise.all(
        uniqueIds.map(async (id) => {
          try {
            const entry = await getEntry(id, activeVaultId)
            if (!entry || entry.is_locked || entry.is_deleted) {
              return [id, undefined] as const
            }
            const title = entry.title?.trim() ?? null
            return [id, title] as const
          } catch {
            return [id, undefined] as const
          }
        }),
      )

      if (cancelled || currentGeneration !== generation) return
      const next = new Map<string, string | null>()
      for (const [id, title] of pairs) {
        if (title !== undefined) next.set(id, title)
      }
      setTitles(next)
      setLoading(false)
    }

    void fetchTitles()

    const handler = () => {
      void fetchTitles()
    }
    window.addEventListener(ENTRIES_CHANGED_EVENT, handler)

    return () => {
      cancelled = true
      window.removeEventListener(ENTRIES_CHANGED_EVENT, handler)
    }
  }, [idsKey, activeVaultId])

  return { titles, loading }
}
