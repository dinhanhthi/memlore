import { useEffect, useState } from 'react'
import { listMemoryItems } from '../lib/tauri'

export type MemoryTextLookup = ReadonlyMap<string, string>

/**
 * Resolve display text for a set of memory item ids (Daily Chat "N memories
 * used" chips). Fetches the WHOLE live memory list once per unique id set and
 * looks up each id in it — unlike `useEntryTitles`, which fetches per-id via
 * `getEntry(id)` and re-fetches on an `entries-changed` window event. There
 * is no per-id memory-item IPC command and no equivalent change event, so
 * this hook cannot mirror that shape; callers should call it ONCE per
 * transcript with the union of every message's memory ids (see
 * `ChatConversation`) rather than once per chip, so a transcript with N
 * memory-using turns makes one `listMemoryItems()` fetch instead of N.
 *
 * A missing map key means the memory was deleted (soft-tombstoned) or the id
 * never existed — `listMemoryItems` only returns non-deleted rows. Disabled
 * memories still resolve: a past turn genuinely used them, so their text
 * stays visible even after the user later disables the item. Callers should
 * derive both the displayed count and the rendered list from the resolved
 * map, not from the raw id count, so a deleted memory can't inflate either.
 */
export function useMemoryTexts(memoryIds: string[]): {
  texts: MemoryTextLookup
  loading: boolean
} {
  const [texts, setTexts] = useState<MemoryTextLookup>(new Map())
  // Start `true` when ids are already known on first render — otherwise the
  // chip wrapper briefly renders hidden (loading=false) then appears once
  // the effect flips it, which is the flicker this hook exists to avoid.
  const [loading, setLoading] = useState(() => memoryIds.length > 0)

  const idsKey = [...new Set(memoryIds)].sort().join('\0')

  useEffect(() => {
    const uniqueIds = idsKey.length > 0 ? idsKey.split('\0') : []
    if (uniqueIds.length === 0) {
      setTexts(new Map())
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    void listMemoryItems()
      .then((items) => {
        if (cancelled) return
        const byId = new Map(items.map((m) => [m.id, m.text]))
        const next = new Map<string, string>()
        for (const id of uniqueIds) {
          const text = byId.get(id)
          if (text !== undefined) next.set(id, text)
        }
        setTexts(next)
      })
      .catch(() => {
        if (!cancelled) setTexts(new Map())
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [idsKey])

  return { texts, loading }
}
