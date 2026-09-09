import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  formatEntryDate,
  formatFriendlyRelativeTime,
  parseISODate,
  formatGroupDateLabel,
  formatCompactDate,
  formatRelativeDate,
  formatTime,
  groupEntriesByDate,
  toISODate,
} from './dates'

// Pin "now" to a fixed point: Monday, April 14, 2026 at 14:30:00 UTC
// entry_date is ALWAYS Unix seconds — multiply *1000 only when creating JS Date objects
const NOW_S = 1744640400 // Monday April 14 2026 14:30:00 UTC (seconds)

// Helpers to build timestamps relative to NOW (in seconds)
const daysAgo = (n: number): number => NOW_S - n * 24 * 60 * 60

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1744640400 * 1000) // setSystemTime always takes ms
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatEntryDate', () => {
  it('formats a timestamp as weekday + month + day', () => {
    const result = formatEntryDate(NOW_S)
    // e.g. "Monday, April 14"
    expect(result).toMatch(/Monday, April 14/)
  })

  it('formats a different date correctly', () => {
    const yesterday = daysAgo(1)
    const result = formatEntryDate(yesterday)
    expect(result).toMatch(/Sunday, April 13/)
  })
})

describe('formatRelativeDate', () => {
  it('returns "Today" for a timestamp within today', () => {
    expect(formatRelativeDate(NOW_S)).toBe('Today')
  })

  it('returns "Today" for earlier same day', () => {
    const earlierToday = NOW_S - 2 * 60 * 60 // 2 hours ago (seconds)
    expect(formatRelativeDate(earlierToday)).toBe('Today')
  })

  it('returns "Yesterday" for a timestamp in yesterday', () => {
    expect(formatRelativeDate(daysAgo(1))).toBe('Yesterday')
  })

  it('returns "2 days ago" for 2 days ago', () => {
    expect(formatRelativeDate(daysAgo(2))).toBe('2 days ago')
  })

  it('returns "3 days ago" for 3 days ago', () => {
    expect(formatRelativeDate(daysAgo(3))).toBe('3 days ago')
  })

  it('falls back to formatEntryDate for older timestamps', () => {
    const old = daysAgo(10)
    const result = formatRelativeDate(old)
    expect(result).not.toBe('Today')
    expect(result).not.toBe('Yesterday')
    expect(result).not.toMatch(/days ago/)
    // Should be a formatted date string
    expect(result).toMatch(/\w+, \w+ \d+/)
  })
})

describe('formatCompactDate', () => {
  it('returns Today / Yesterday for 0–1 days', () => {
    expect(formatCompactDate(NOW_S)).toBe('Today')
    expect(formatCompactDate(daysAgo(1))).toBe('Yesterday')
  })

  it('returns Nd for 2–6 days ago', () => {
    expect(formatCompactDate(daysAgo(2))).toBe('2d')
    expect(formatCompactDate(daysAgo(6))).toBe('6d')
  })

  it('returns short month+day for older dates this year', () => {
    expect(formatCompactDate(daysAgo(10))).toMatch(/Apr 4/)
  })

  it('includes the year when it is not the current year', () => {
    const lastYear = daysAgo(400)
    expect(formatCompactDate(lastYear)).toMatch(/\d{4}/)
    expect(formatCompactDate(lastYear)).not.toBe('Today')
  })

  it('localizes today/yesterday in vi', () => {
    expect(formatCompactDate(NOW_S, 'vi')).toBe('Hôm nay')
    expect(formatCompactDate(daysAgo(1), 'vi')).toBe('Hôm qua')
  })
})

describe('formatFriendlyRelativeTime', () => {
  const minutesAgo = (n: number): number => NOW_S - n * 60
  const hoursAgo = (n: number): number => NOW_S - n * 60 * 60

  it('returns "now" for the last second and future timestamps', () => {
    expect(formatFriendlyRelativeTime(NOW_S)).toBe('now')
    expect(formatFriendlyRelativeTime(NOW_S + 10)).toBe('now')
  })

  it('returns Ns for timestamps under a minute', () => {
    expect(formatFriendlyRelativeTime(NOW_S - 30)).toBe('30s')
  })

  it('returns Nm for timestamps under an hour', () => {
    expect(formatFriendlyRelativeTime(minutesAgo(5))).toBe('5m')
  })

  it('returns Nh for timestamps under a day', () => {
    expect(formatFriendlyRelativeTime(hoursAgo(2))).toBe('2h')
  })

  it('returns Nd for 1–6 days ago', () => {
    expect(formatFriendlyRelativeTime(daysAgo(1))).toBe('1d')
    expect(formatFriendlyRelativeTime(daysAgo(2))).toBe('2d')
    expect(formatFriendlyRelativeTime(daysAgo(3))).toBe('3d')
  })

  it('falls back to formatEntryDate for timestamps 7+ days old', () => {
    const old = daysAgo(10)
    expect(formatFriendlyRelativeTime(old)).toBe(formatEntryDate(old))
  })
})

describe('formatTime', () => {
  it('formats in 24-hour by default (no AM/PM)', () => {
    // NOW_S = 14:30 UTC
    const result = formatTime(NOW_S)
    expect(result).toMatch(/^\d{2}:\d{2}$/)
    expect(result).not.toMatch(/AM|PM/)
  })

  it('formats midnight as 00:05 in 24h', () => {
    const midnight = Math.floor(new Date(2026, 3, 14, 0, 5, 0).getTime() / 1000)
    expect(formatTime(midnight)).toBe('00:05')
  })

  it('formats noon as 12:00 in 24h', () => {
    const noon = Math.floor(new Date(2026, 3, 14, 12, 0, 0).getTime() / 1000)
    expect(formatTime(noon)).toBe('12:00')
  })

  it('formats afternoon as 14:30 in 24h', () => {
    const afternoon = Math.floor(new Date(2026, 3, 14, 14, 30, 0).getTime() / 1000)
    expect(formatTime(afternoon)).toBe('14:30')
  })

  it('formats with AM/PM when hour12=true', () => {
    const result = formatTime(NOW_S, undefined, true)
    expect(result).toMatch(/\d{1,2}:\d{2} (AM|PM)/)
  })

  it('formats midnight as 12:05 AM when hour12=true', () => {
    const midnight = Math.floor(new Date(2026, 3, 14, 0, 5, 0).getTime() / 1000)
    expect(formatTime(midnight, undefined, true)).toMatch(/12:05 AM/)
  })

  it('formats noon as 12:00 PM when hour12=true', () => {
    const noon = Math.floor(new Date(2026, 3, 14, 12, 0, 0).getTime() / 1000)
    expect(formatTime(noon, undefined, true)).toMatch(/12:00 PM/)
  })
})

describe('groupEntriesByDate', () => {
  it('groups entries from today into "today"', () => {
    const entries = [{ id: '1', entry_date: NOW_S }]
    const groups = groupEntriesByDate(entries)
    expect(groups.has('today')).toBe(true)
    expect(groups.get('today')).toHaveLength(1)
  })

  it('groups entries from yesterday into "yesterday"', () => {
    const entries = [{ id: '2', entry_date: daysAgo(1) }]
    const groups = groupEntriesByDate(entries)
    expect(groups.has('yesterday')).toBe(true)
  })

  it('groups entries from 3 days ago into their own ISO date key', () => {
    const entries = [{ id: '3', entry_date: daysAgo(3) }]
    const groups = groupEntriesByDate(entries)
    // Expect a single key matching YYYY-MM-DD
    const keys = Array.from(groups.keys())
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(keys[0]).not.toBe('today')
    expect(keys[0]).not.toBe('yesterday')
  })

  it('groups older entries into per-day ISO buckets', () => {
    const entries = [{ id: '4', entry_date: daysAgo(30) }]
    const groups = groupEntriesByDate(entries)
    const keys = Array.from(groups.keys())
    expect(keys[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('puts two entries from the same older day into the same group', () => {
    const dayA = daysAgo(5)
    const dayASameDayLater = dayA + 60 * 60 // 1 hour later, same day
    const entries = [
      { id: '1', entry_date: dayA },
      { id: '2', entry_date: dayASameDayLater },
    ]
    const groups = groupEntriesByDate(entries)
    expect(groups.size).toBe(1)
    const onlyGroup = Array.from(groups.values())[0]
    expect(onlyGroup).toHaveLength(2)
  })

  it('handles multiple entries across multiple days', () => {
    const entries = [
      { id: '1', entry_date: NOW_S },
      { id: '2', entry_date: daysAgo(1) },
      { id: '3', entry_date: daysAgo(5) },
      { id: '4', entry_date: daysAgo(30) },
    ]
    const groups = groupEntriesByDate(entries)
    expect(groups.get('today')).toHaveLength(1)
    expect(groups.get('yesterday')).toHaveLength(1)
    // Two separate ISO-date groups for days 5 and 30
    const isoKeys = Array.from(groups.keys()).filter((k) => k !== 'today' && k !== 'yesterday')
    expect(isoKeys).toHaveLength(2)
  })

  it('returns empty map for empty array', () => {
    const groups = groupEntriesByDate([])
    expect(groups.size).toBe(0)
  })
})

describe('parseISODate', () => {
  it('parses a valid ISO date', () => {
    expect(parseISODate('2026-04-14')).toEqual({ year: 2026, month: 4, day: 14 })
  })

  it('trims surrounding whitespace', () => {
    expect(parseISODate('  2026-01-01  ')).toEqual({ year: 2026, month: 1, day: 1 })
  })

  it('rejects malformed strings', () => {
    expect(parseISODate('2026/04/14')).toBeNull()
    expect(parseISODate('26-04-14')).toBeNull()
    expect(parseISODate('not-a-date')).toBeNull()
    expect(parseISODate('')).toBeNull()
  })

  it('rejects invalid month and day values', () => {
    expect(parseISODate('2026-00-01')).toBeNull()
    expect(parseISODate('2026-13-01')).toBeNull()
    expect(parseISODate('2026-02-30')).toBeNull()
    expect(parseISODate('2026-04-31')).toBeNull()
  })

  it('accepts leap-day on leap years only', () => {
    expect(parseISODate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 })
    expect(parseISODate('2026-02-29')).toBeNull()
  })
})

describe('toISODate', () => {
  it('converts a unix seconds timestamp to YYYY-MM-DD', () => {
    expect(toISODate(NOW_S)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns the correct local date for a known timestamp', () => {
    const midnight = Math.floor(new Date(2026, 3, 14, 0, 0, 0).getTime() / 1000)
    expect(toISODate(midnight)).toBe('2026-04-14')
  })

  it('pads month and day with leading zeros', () => {
    const jan1 = Math.floor(new Date(2026, 0, 1, 12, 0, 0).getTime() / 1000)
    expect(toISODate(jan1)).toBe('2026-01-01')
  })

  it('handles end of year correctly', () => {
    const dec31 = Math.floor(new Date(2026, 11, 31, 12, 0, 0).getTime() / 1000)
    expect(toISODate(dec31)).toBe('2026-12-31')
  })
})

describe('formatGroupDateLabel', () => {
  // NOW_S = April 14, 2025 (despite the misleading "2026" name in the older comments)
  it('omits the year for dates in the current year (2025)', () => {
    const result = formatGroupDateLabel('2025-04-10')
    expect(result).not.toMatch(/2025/)
    expect(result).toMatch(/Apr/)
    expect(result).toMatch(/10/)
  })

  it('includes the year for dates in a different year', () => {
    const result = formatGroupDateLabel('2024-12-31')
    expect(result).toMatch(/2024/)
    expect(result).toMatch(/Dec/)
  })

  it('formats with Vietnamese locale', () => {
    const result = formatGroupDateLabel('2025-04-10', 'vi')
    // vi-VN month name for April is "thg 4" or "tháng 4"
    expect(result).toMatch(/thg|tháng|4/i)
  })
})

describe('formatEntryDate with vi locale', () => {
  it('formats a timestamp in Vietnamese locale', () => {
    const result = formatEntryDate(NOW_S, 'vi')
    // vi-VN weekday (Thứ Hai = Monday, Thứ Ba = Tuesday, etc.)
    expect(result).toMatch(/Thứ/)
  })
})

describe('formatRelativeDate with vi locale', () => {
  it('returns "Hôm nay" for today in Vietnamese', () => {
    expect(formatRelativeDate(NOW_S, 'vi')).toBe('Hôm nay')
  })

  it('returns "Hôm qua" for yesterday in Vietnamese', () => {
    expect(formatRelativeDate(daysAgo(1), 'vi')).toBe('Hôm qua')
  })

  it('returns "2 ngày trước" for 2 days ago in Vietnamese', () => {
    expect(formatRelativeDate(daysAgo(2), 'vi')).toBe('2 ngày trước')
  })
})

describe('formatFriendlyRelativeTime with vi locale', () => {
  it('uses the same compact unit letters regardless of locale', () => {
    expect(formatFriendlyRelativeTime(NOW_S, 'vi')).toBe('now')
    expect(formatFriendlyRelativeTime(daysAgo(1), 'vi')).toBe('1d')
    expect(formatFriendlyRelativeTime(daysAgo(2), 'vi')).toBe('2d')
  })
})

describe('formatTime with vi locale', () => {
  it('formats time in Vietnamese locale (24h by default)', () => {
    const result = formatTime(NOW_S, 'vi')
    expect(result).toMatch(/^\d{1,2}:\d{2}$/)
  })
})
