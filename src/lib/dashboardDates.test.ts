import { describe, expect, it } from 'vitest'
import { insightsRange, localDateKey } from './dashboardDates'

function isLocalMidnight(unixSeconds: number): boolean {
  const d = new Date(unixSeconds * 1000)
  return (
    d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
  )
}

function addLocalCalendarDays(unixSeconds: number, days: number): number {
  const d = new Date(unixSeconds * 1000)
  d.setDate(d.getDate() + days)
  return d.getTime() / 1000
}

describe('localDateKey', () => {
  it('formats YYYY-MM-DD with padded month and day in local time', () => {
    expect(localDateKey(new Date(2026, 0, 5, 9, 8, 7))).toBe('2026-01-05')
    expect(localDateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
  })

  it('uses the local calendar date, not UTC', () => {
    const now = new Date(2026, 3, 14, 22, 30, 0)
    expect(localDateKey(now)).toBe('2026-04-14')
  })

  it('does not mutate the caller Date', () => {
    const now = new Date(2026, 3, 14, 14, 30, 0)
    const before = now.getTime()
    localDateKey(now)
    expect(now.getTime()).toBe(before)
  })
})

describe('insightsRange', () => {
  const FIXED = [
    { name: 'mid-April afternoon', now: new Date(2026, 3, 14, 14, 30, 0) },
    { name: 'just after midnight', now: new Date(2026, 3, 14, 0, 0, 1) },
    { name: 'late evening', now: new Date(2026, 3, 14, 23, 59, 59) },
    // US spring-forward 2026 is 8 Mar; this window includes that day.
    { name: 'DST spring-forward month', now: new Date(2026, 2, 10, 15, 45, 30) },
    // US fall-back 2026 is 1 Nov; this window includes that day.
    { name: 'DST fall-back month', now: new Date(2026, 10, 3, 9, 0, 0) },
  ]

  it('returns an end that is a local midnight', () => {
    for (const { name, now } of FIXED) {
      expect(isLocalMidnight(insightsRange(now).end), name).toBe(true)
    }
  })

  it('returns an end in the future relative to now (unix seconds)', () => {
    for (const { name, now } of FIXED) {
      expect(insightsRange(now).end, name).toBeGreaterThan(now.getTime() / 1000)
    }
  })

  it('spans exactly 30 calendar days by local date', () => {
    for (const { name, now } of FIXED) {
      const { start, end } = insightsRange(now)
      expect(isLocalMidnight(start), name).toBe(true)
      expect(addLocalCalendarDays(start, 30), name).toBe(end)
    }
  })

  it('returns an identical range for any time on the same calendar day', () => {
    const morning = new Date(2026, 3, 14, 0, 0, 1)
    const noon = new Date(2026, 3, 14, 12, 0, 0)
    const evening = new Date(2026, 3, 14, 23, 59, 59)
    expect(insightsRange(morning)).toEqual(insightsRange(noon))
    expect(insightsRange(noon)).toEqual(insightsRange(evening))
  })

  it('keeps local-midnight bounds across a DST-transition month', () => {
    const now = new Date(2026, 2, 10, 15, 45, 30)
    const { start, end } = insightsRange(now)
    expect(isLocalMidnight(start)).toBe(true)
    expect(isLocalMidnight(end)).toBe(true)
    expect(addLocalCalendarDays(start, 30)).toBe(end)
    expect(end).toBeGreaterThan(now.getTime() / 1000)
  })

  it('does not mutate the caller Date', () => {
    const now = new Date(2026, 3, 14, 14, 30, 0)
    const before = now.getTime()
    insightsRange(now)
    expect(now.getTime()).toBe(before)
  })
})
