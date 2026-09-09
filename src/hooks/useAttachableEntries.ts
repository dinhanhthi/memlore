import { useEffect, useState } from 'react'
import { chatSearchAttachableEntries, type ChatAttachableEntry } from '../lib/tauri'

const DEBOUNCE_MS = 150
const DEFAULT_LIMIT = 5

/**
 * Debounced entries lookup for the Daily Chat attachment popover's Entries
 * tab. An empty `query` returns the `limit` most recent entries; a non-empty
 * query is routed through the backend's diacritic-insensitive FTS search.
 * Locked and invisible entries are excluded server-side.
 */
export function useAttachableEntries(
  query: string,
  limit: number = DEFAULT_LIMIT,
): {
  entries: ChatAttachableEntry[]
  loading: boolean
} {
  const [entries, setEntries] = useState<ChatAttachableEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const handle = setTimeout(() => {
      chatSearchAttachableEntries(query, limit)
        .then((found) => {
          if (cancelled) return
          setEntries(found)
          setLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          setEntries([])
          setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query, limit])

  return { entries, loading }
}
