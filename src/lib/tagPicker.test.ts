import { describe, expect, it } from 'vitest'
import type { Tag } from '../types/journal'
import { canCreateTagName, filterTagSuggestions, sortTagsByName } from './tagPicker'

const tag = (id: string, name: string): Tag => ({ id, name, color: '#7C3AED' })

describe('tagPicker', () => {
  it('sortTagsByName orders case-insensitively', () => {
    const sorted = sortTagsByName([tag('2', 'Beta'), tag('1', 'alpha'), tag('3', 'Gamma')])
    expect(sorted.map((t) => t.name)).toEqual(['alpha', 'Beta', 'Gamma'])
  })

  it('filterTagSuggestions excludes ids and filters by query', () => {
    const tags = [tag('a', 'alpha'), tag('b', 'beta'), tag('c', 'work')]
    expect(filterTagSuggestions(tags, { excludeIds: ['b'], query: 'a' }).map((t) => t.id)).toEqual([
      'a',
    ])
  })

  it('filterTagSuggestions returns all unselected tags when query is empty', () => {
    const tags = [tag('a', 'alpha'), tag('b', 'beta')]
    expect(filterTagSuggestions(tags).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('canCreateTagName rejects duplicates case-insensitively', () => {
    const tags = [tag('a', 'Work')]
    expect(canCreateTagName(tags, 'work')).toBe(false)
    expect(canCreateTagName(tags, 'personal')).toBe(true)
    expect(canCreateTagName(tags, '   ')).toBe(false)
  })
})
