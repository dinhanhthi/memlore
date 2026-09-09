import { useEffect, useState } from 'react'
import { listAllEntriesPaged } from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import { useSecondLockStore } from '../stores/secondLockStore'
import type { Entry } from '../types/entry'

const ENTRIES_CHANGED_EVENT = 'memlore:entries-changed'

export function useRecentEntries(limit = 3): {
  entries: Entry[]
  isLoading: boolean
  error: string | null
} {
  const [entries, setEntries] = useState<Entry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  useEffect(() => {
    let cancelled = false
    let requestSequence = 0

    const fetchEntries = () => {
      const sequence = ++requestSequence
      setIsLoading(true)
      setError(null)
      // page=1; PAGE_SIZE is 20 (src/types/pagination.ts). Slice to `limit`.
      listAllEntriesPaged('newest', 'all', null, null, 1, 1, lockedView, activeVaultId, 'all')
        .then((result) => {
          if (cancelled || sequence !== requestSequence) return
          setEntries(result.items.slice(0, limit))
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          if (cancelled || sequence !== requestSequence) return
          setEntries([])
          setError(err instanceof Error ? err.message : String(err))
          setIsLoading(false)
        })
    }

    fetchEntries()
    window.addEventListener(ENTRIES_CHANGED_EVENT, fetchEntries)
    return () => {
      cancelled = true
      window.removeEventListener(ENTRIES_CHANGED_EVENT, fetchEntries)
    }
  }, [limit, lockedView, activeVaultId])

  return { entries, isLoading, error }
}
