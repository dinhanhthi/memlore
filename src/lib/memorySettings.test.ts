import { describe, expect, it } from 'vitest'
import {
  filterMemoryItemsByQuery,
  fuzzyTokenMatches,
  normalizeSearchText,
  tightestSubsequenceSpan,
} from './memorySettings'

const items = [
  { id: '1', text: 'User likes hiking in the mountains' },
  { id: '2', text: 'Prefers green tea in the morning' },
  { id: '3', text: 'Works remotely from Đà Nẵng' },
  { id: '4', text: 'Loves phở and cà phê sữa đá' },
]

describe('normalizeSearchText', () => {
  it('lowercases and strips diacritics including Vietnamese', () => {
    expect(normalizeSearchText('Đà Nẵng')).toBe('da nang')
    expect(normalizeSearchText('cà phê sữa đá')).toBe('ca phe sua da')
    expect(normalizeSearchText('HIKING')).toBe('hiking')
  })

  it('maps đ/Đ to d (NFD does not decompose them)', () => {
    expect(normalizeSearchText('đường')).toBe('duong')
    expect(normalizeSearchText('ĐƯỜNG')).toBe('duong')
  })
})

describe('tightestSubsequenceSpan', () => {
  it('returns contiguous length for exact runs', () => {
    expect(tightestSubsequenceSpan('tea', 'green tea morning')).toBe(3)
    expect(tightestSubsequenceSpan('morning', 'prefers green tea in the morning')).toBe(7)
  })

  it('returns span for non-contiguous abbreviations', () => {
    expect(tightestSubsequenceSpan('mrng', 'morning')).toBe(7)
  })

  it('returns null when no subsequence exists', () => {
    expect(tightestSubsequenceSpan('xyz', 'morning')).toBeNull()
    expect(tightestSubsequenceSpan('tea', '')).toBeNull()
  })
})

describe('fuzzyTokenMatches', () => {
  it('matches contiguous substrings of any length', () => {
    expect(fuzzyTokenMatches('tea', 'prefers green tea in the morning')).toBe(true)
    expect(fuzzyTokenMatches('hi', 'user likes hiking')).toBe(true)
  })

  it('allows tight fuzzy subsequence for tokens of length >= 3', () => {
    expect(fuzzyTokenMatches('mrng', 'prefers green tea in the morning')).toBe(true)
    expect(fuzzyTokenMatches('hkng', 'user likes hiking in the mountains')).toBe(true)
  })

  it('rejects sparse subsequence noise for short tokens', () => {
    // "tea" chars appear sparsely across "works remotely from da nang" if
    // subsequence were unbounded — must NOT match without contiguous "tea".
    expect(fuzzyTokenMatches('tea', 'works remotely from da nang')).toBe(false)
  })

  it('rejects subsequence that spans too widely', () => {
    // m…r…n…g across the whole sentence is too loose vs "mrng" → "morning".
    expect(fuzzyTokenMatches('mrng', 'user likes hiking in the mountains')).toBe(false)
  })
})

describe('filterMemoryItemsByQuery', () => {
  it('returns a copy of all items for blank / whitespace query', () => {
    expect(filterMemoryItemsByQuery(items, '')).toEqual(items)
    expect(filterMemoryItemsByQuery(items, '   ')).toEqual(items)
    expect(filterMemoryItemsByQuery(items, '')).not.toBe(items)
  })

  it('matches case-insensitively on contiguous substrings', () => {
    expect(filterMemoryItemsByQuery(items, 'HIKING').map((i) => i.id)).toEqual(['1'])
    expect(filterMemoryItemsByQuery(items, 'tea').map((i) => i.id)).toEqual(['2'])
  })

  it('matches fuzzy subsequences (typo-tolerant abbreviations)', () => {
    expect(filterMemoryItemsByQuery(items, 'mrng').map((i) => i.id)).toEqual(['2'])
    expect(filterMemoryItemsByQuery(items, 'hkng mntns').map((i) => i.id)).toEqual(['1'])
  })

  it('folds Vietnamese diacritics for query and text', () => {
    expect(filterMemoryItemsByQuery(items, 'da nang').map((i) => i.id)).toEqual(['3'])
    expect(filterMemoryItemsByQuery(items, 'pho').map((i) => i.id)).toEqual(['4'])
    expect(filterMemoryItemsByQuery(items, 'ca phe').map((i) => i.id)).toEqual(['4'])
  })

  it('requires every token (AND) and preserves token independence', () => {
    expect(filterMemoryItemsByQuery(items, 'green morning').map((i) => i.id)).toEqual(['2'])
    expect(filterMemoryItemsByQuery(items, 'green coffee')).toEqual([])
    // Order of tokens does not matter (unlike whole-query subsequence).
    expect(filterMemoryItemsByQuery(items, 'morning green').map((i) => i.id)).toEqual(['2'])
  })

  it('returns empty when nothing matches', () => {
    expect(filterMemoryItemsByQuery(items, 'skydiving')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const original = [...items]
    filterMemoryItemsByQuery(items, 'tea')
    expect(items).toEqual(original)
  })
})
