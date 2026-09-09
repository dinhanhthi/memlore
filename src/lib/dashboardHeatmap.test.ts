import { describe, expect, it } from 'vitest'
import { localDateKey } from './dashboardDates'
import { heatmapWindow } from './dashboardHeatmap'

function weekdayOf(key: string): number {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

describe('heatmapWindow', () => {
  it('returns weeks * 7 local YYYY-MM-DD keys', () => {
    const { days } = heatmapWindow(new Date(2026, 8, 5), 16, 'en')
    expect(days).toHaveLength(112)
    expect(days[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(days[days.length - 1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('starts on Sunday for the en locale', () => {
    const { days } = heatmapWindow(new Date(2026, 8, 5), 16, 'en')
    expect(weekdayOf(days[0])).toBe(0)
  })

  it('ends on the last day of the week containing now', () => {
    const now = new Date(2026, 8, 5)
    const { days } = heatmapWindow(now, 16, 'en')
    const last = days[days.length - 1]
    expect(last >= localDateKey(now)).toBe(true)
    // Sep 5 2026 is Saturday — Sunday-first week ends that day.
    expect(last).toBe('2026-09-05')
    expect(weekdayOf(last)).toBe(6)
  })

  it('reports a single year when the window stays in 2026', () => {
    const { years } = heatmapWindow(new Date(2026, 8, 5), 16, 'en')
    expect(years).toEqual([2026])
  })

  it('reports [2025, 2026] when the window crosses the year boundary', () => {
    const { years } = heatmapWindow(new Date(2026, 0, 10), 16, 'en')
    expect(years).toEqual([2025, 2026])
  })

  it('starts on Monday for the vi locale', () => {
    const { days } = heatmapWindow(new Date(2026, 8, 5), 16, 'vi')
    expect(weekdayOf(days[0])).toBe(1)
  })

  it('consecutive keys differ by one calendar day across a DST month', () => {
    // US spring-forward 2026 is 8 Mar; this window includes that day.
    const { days } = heatmapWindow(new Date(2026, 2, 20, 15, 45, 30), 16, 'en')
    expect(days).toContain('2026-03-08')
    for (let i = 1; i < days.length; i++) {
      const [year, month, day] = days[i - 1].split('-').map(Number)
      const next = new Date(year, month - 1, day + 1)
      expect(days[i]).toBe(localDateKey(next))
    }
  })

  it('does not mutate the caller Date', () => {
    const now = new Date(2026, 8, 5, 14, 30, 0)
    const before = now.getTime()
    heatmapWindow(now, 16, 'en')
    expect(now.getTime()).toBe(before)
  })
})
