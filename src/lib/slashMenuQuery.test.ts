import { describe, expect, it } from 'vitest'
import { filterSlashItems, matchesSlashItem, type SlashQueryItem } from './slashMenuQuery'

const todayVi: SlashQueryItem = {
  key: 'today',
  label: 'Hôm nay',
  aliases: ['date'],
}

describe('matchesSlashItem', () => {
  it('matches everything when query is empty', () => {
    expect(matchesSlashItem(todayVi, '')).toBe(true)
  })

  it('matches everything when query is whitespace-only', () => {
    expect(matchesSlashItem(todayVi, '   ')).toBe(true)
  })

  it('matches the English key even when the label is Vietnamese', () => {
    expect(matchesSlashItem(todayVi, 'today')).toBe(true)
  })

  it('matches via alias so /date finds today', () => {
    expect(matchesSlashItem(todayVi, 'date')).toBe(true)
  })

  it('matches a Vietnamese label substring', () => {
    expect(matchesSlashItem(todayVi, 'hôm')).toBe(true)
  })

  it('matches keys case-insensitively', () => {
    expect(matchesSlashItem(todayVi, 'TODAY')).toBe(true)
  })

  it('matches aliases case-insensitively', () => {
    expect(matchesSlashItem(todayVi, 'Date')).toBe(true)
  })

  it('does not match an unrelated query', () => {
    expect(matchesSlashItem(todayVi, 'yesterday')).toBe(false)
  })

  it('trims the query before matching', () => {
    expect(matchesSlashItem(todayVi, '  today  ')).toBe(true)
  })

  it('treats the query as a literal substring, not a regex', () => {
    expect(() => matchesSlashItem(todayVi, 'today(')).not.toThrow()
    // `tod.` as a RegExp would match "today"; includes() must not.
    expect(matchesSlashItem(todayVi, 'tod.')).toBe(false)
  })
})

describe('filterSlashItems', () => {
  const items: SlashQueryItem[] = [
    todayVi,
    { key: 'yesterday', label: 'Hôm qua' },
    { key: 'time', label: 'Giờ', aliases: ['clock'] },
  ]

  it('returns every item when the query is empty', () => {
    expect(filterSlashItems(items, '')).toEqual(items)
  })

  it('keeps only items that match key, alias, or label', () => {
    expect(filterSlashItems(items, 'date')).toEqual([todayVi])
  })
})
