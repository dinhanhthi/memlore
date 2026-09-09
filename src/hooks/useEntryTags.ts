import { useEffect, useState } from 'react'
import { getTagsForEntries } from '../lib/tauri'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'
import type { Tag } from '../types/journal'

export const EMPTY_TAGS: readonly Tag[] = Object.freeze([])

const EMPTY_ENTRY_TAGS = new Map<string, Tag[]>()

interface LoadedEntryTags {
  requestKey: string
  tags: Map<string, Tag[]>
}

export function useEntryTags(entryIds: string[]): Map<string, Tag[]> {
  const activeVaultId = useInvisibleLockStore((state) => state.activeVaultId)
  const distinctEntryIdsKey = Array.from(new Set(entryIds)).sort().join(',')
  const requestKey = `${activeVaultId}:${distinctEntryIdsKey}`
  const [loaded, setLoaded] = useState<LoadedEntryTags>({
    requestKey: '',
    tags: EMPTY_ENTRY_TAGS,
  })

  useEffect(() => {
    if (!distinctEntryIdsKey) {
      setLoaded({ requestKey: '', tags: EMPTY_ENTRY_TAGS })
      return
    }

    const distinctEntryIds = distinctEntryIdsKey.split(',')
    let cancelled = false
    let requestSequence = 0

    const fetchTags = (clearCurrent: boolean) => {
      const sequence = ++requestSequence
      if (clearCurrent) {
        setLoaded({ requestKey: '', tags: EMPTY_ENTRY_TAGS })
      }
      void getTagsForEntries(distinctEntryIds, activeVaultId)
        .then((tagsByEntry) => {
          if (cancelled || sequence !== requestSequence) return
          setLoaded({ requestKey, tags: new Map(Object.entries(tagsByEntry)) })
        })
        .catch(() => {
          if (cancelled || sequence !== requestSequence) return
          setLoaded({ requestKey, tags: EMPTY_ENTRY_TAGS })
        })
    }

    fetchTags(true)
    const handleChange = () => fetchTags(true)
    window.addEventListener('memlore:tags-changed', handleChange)
    window.addEventListener('memlore:entries-changed', handleChange)

    return () => {
      cancelled = true
      window.removeEventListener('memlore:tags-changed', handleChange)
      window.removeEventListener('memlore:entries-changed', handleChange)
    }
  }, [distinctEntryIdsKey, requestKey, activeVaultId])

  return loaded.requestKey === requestKey ? loaded.tags : EMPTY_ENTRY_TAGS
}
