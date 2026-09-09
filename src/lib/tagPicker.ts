import type { Tag } from '../types/journal'

/** Stable A→Z ordering for every tag suggestion list. */
export function sortTagsByName(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function tagNameMatchesQuery(tag: Tag, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (q === '') return true
  return tag.name.toLowerCase().includes(q)
}

/** True when the trimmed query is non-empty and no tag already owns that name. */
export function canCreateTagName(tags: Tag[], rawQuery: string): boolean {
  const trimmed = rawQuery.trim()
  if (trimmed.length === 0) return false
  const needle = trimmed.toLowerCase()
  return !tags.some((tag) => tag.name.toLowerCase() === needle)
}

export interface TagSuggestionOptions {
  query?: string
  excludeIds?: Iterable<string>
}

/** All assignable tag suggestions for pickers — no artificial cap. */
export function filterTagSuggestions(tags: Tag[], options: TagSuggestionOptions = {}): Tag[] {
  const exclude = new Set(options.excludeIds ?? [])
  const query = options.query ?? ''
  return sortTagsByName(tags)
    .filter((tag) => !exclude.has(tag.id))
    .filter((tag) => tagNameMatchesQuery(tag, query))
}
