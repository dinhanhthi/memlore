import { describe, expect, it } from 'vitest'
import {
  applyTimeRange,
  availableLockFilterOptions,
  coerceLockFilter,
  isLockFilterMenuVisible,
  resolveLockFilterVisibility,
  shouldShowInvisibleLockEntrySignals,
  shouldShowSecondLockEntrySignals,
  sortEntries,
  timeRangeBounds,
  type SortOrder,
  type TimeRange,
} from './entryFilterSort'

// Minimal entry shape covering the fields the utility cares about.
// Real Entry has many more — we type the helper generically so tests
// can use a stripped-down shape.
interface TestEntry {
  id: string
  entry_date: number
  updated_at: number
  created_at: number
}

const sec = (date: string): number => Math.floor(new Date(date).getTime() / 1000)

describe('timeRangeBounds', () => {
  // Fixed anchor: Wednesday, 2026-05-13 14:30:00 local time.
  const NOW = new Date(2026, 4, 13, 14, 30, 0).getTime() / 1000

  it('returns null when range is "all"', () => {
    expect(timeRangeBounds({ kind: 'all' }, { now: NOW })).toBeNull()
  })

  it('returns this-week bounds with Monday start (en-GB / vi)', () => {
    const r = timeRangeBounds({ kind: 'thisWeek' }, { now: NOW, firstDayOfWeek: 1 })
    expect(r).not.toBeNull()
    if (!r) return
    expect(new Date(r.from * 1000).getDay()).toBe(1)
    // Week start <= now < week start + 7 days
    expect(r.from).toBeLessThanOrEqual(NOW)
    expect(r.toExclusive).toBeGreaterThan(NOW)
    expect(r.toExclusive - r.from).toBe(7 * 24 * 60 * 60)
  })

  it('returns this-week bounds with Sunday start (en-US)', () => {
    const r = timeRangeBounds({ kind: 'thisWeek' }, { now: NOW, firstDayOfWeek: 0 })
    expect(r).not.toBeNull()
    if (!r) return
    expect(new Date(r.from * 1000).getDay()).toBe(0)
  })

  it('returns this-month bounds spanning the calendar month', () => {
    const r = timeRangeBounds({ kind: 'thisMonth' }, { now: NOW })
    expect(r).not.toBeNull()
    if (!r) return
    const from = new Date(r.from * 1000)
    const to = new Date(r.toExclusive * 1000)
    expect(from.getDate()).toBe(1)
    expect(from.getMonth()).toBe(4) // May
    expect(to.getMonth()).toBe(5) // June (exclusive)
    expect(to.getDate()).toBe(1)
  })

  it('returns this-year bounds spanning Jan 1 → Jan 1 next year', () => {
    const r = timeRangeBounds({ kind: 'thisYear' }, { now: NOW })
    expect(r).not.toBeNull()
    if (!r) return
    const from = new Date(r.from * 1000)
    const to = new Date(r.toExclusive * 1000)
    expect(from.getFullYear()).toBe(2026)
    expect(from.getMonth()).toBe(0)
    expect(from.getDate()).toBe(1)
    expect(to.getFullYear()).toBe(2027)
    expect(to.getMonth()).toBe(0)
    expect(to.getDate()).toBe(1)
  })

  it('returns custom range bounds covering [from..to] inclusive of the end day', () => {
    const range: TimeRange = {
      kind: 'custom',
      fromDateIso: '2026-03-01',
      toDateIso: '2026-03-31',
    }
    const r = timeRangeBounds(range, { now: NOW })
    expect(r).not.toBeNull()
    if (!r) return
    const from = new Date(r.from * 1000)
    const to = new Date(r.toExclusive * 1000)
    expect(from.getFullYear()).toBe(2026)
    expect(from.getMonth()).toBe(2)
    expect(from.getDate()).toBe(1)
    // Exclusive end is the day AFTER toDateIso, so an entry on 03-31 is included.
    expect(to.getFullYear()).toBe(2026)
    expect(to.getMonth()).toBe(3)
    expect(to.getDate()).toBe(1)
  })

  it('returns null when custom range is missing from/to', () => {
    expect(timeRangeBounds({ kind: 'custom', fromDateIso: null, toDateIso: null })).toBeNull()
    expect(
      timeRangeBounds({ kind: 'custom', fromDateIso: '2026-03-01', toDateIso: null }),
    ).toBeNull()
  })

  it('returns null when custom range has from > to', () => {
    expect(
      timeRangeBounds({
        kind: 'custom',
        fromDateIso: '2026-03-31',
        toDateIso: '2026-03-01',
      }),
    ).toBeNull()
  })
})

describe('applyTimeRange', () => {
  const entries: TestEntry[] = [
    { id: 'a', entry_date: sec('2026-05-13T10:00:00'), updated_at: 0, created_at: 0 },
    { id: 'b', entry_date: sec('2026-05-01T10:00:00'), updated_at: 0, created_at: 0 },
    { id: 'c', entry_date: sec('2026-04-15T10:00:00'), updated_at: 0, created_at: 0 },
    { id: 'd', entry_date: sec('2025-12-25T10:00:00'), updated_at: 0, created_at: 0 },
  ]
  const NOW = new Date(2026, 4, 13, 14, 30, 0).getTime() / 1000

  it('returns all entries for "all" range', () => {
    const out = applyTimeRange(entries, { kind: 'all' }, { now: NOW })
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('filters to this month (May 2026)', () => {
    const out = applyTimeRange(entries, { kind: 'thisMonth' }, { now: NOW })
    expect(out.map((e) => e.id).sort()).toEqual(['a', 'b'])
  })

  it('filters to this year (2026)', () => {
    const out = applyTimeRange(entries, { kind: 'thisYear' }, { now: NOW })
    expect(out.map((e) => e.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('filters by custom range inclusive of both endpoints', () => {
    const out = applyTimeRange(
      entries,
      { kind: 'custom', fromDateIso: '2026-04-15', toDateIso: '2026-05-01' },
      { now: NOW },
    )
    expect(out.map((e) => e.id).sort()).toEqual(['b', 'c'])
  })
})

describe('entry lock signal visibility', () => {
  it('shows second-lock signals only when second-lock visibility allows', () => {
    const hidden = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: false,
      showExistence: false,
      invisibleSessionUnlocked: false,
    })
    const covered = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: false,
      showExistence: true,
      invisibleSessionUnlocked: false,
    })
    const revealed = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: true,
      showExistence: false,
      invisibleSessionUnlocked: false,
    })

    expect(shouldShowSecondLockEntrySignals(hidden)).toBe(false)
    expect(shouldShowSecondLockEntrySignals(covered)).toBe(true)
    expect(shouldShowSecondLockEntrySignals(revealed)).toBe(true)
  })

  it('shows invisible-lock signals only when the invisible session is unlocked', () => {
    const locked = resolveLockFilterVisibility({
      secondLockEnabled: false,
      secondLockSessionUnlocked: false,
      showExistence: false,
      invisibleSessionUnlocked: false,
    })
    const unlocked = resolveLockFilterVisibility({
      secondLockEnabled: false,
      secondLockSessionUnlocked: false,
      showExistence: false,
      invisibleSessionUnlocked: true,
    })

    expect(shouldShowInvisibleLockEntrySignals(locked)).toBe(false)
    expect(shouldShowInvisibleLockEntrySignals(unlocked)).toBe(true)
  })
})

describe('lock filter visibility', () => {
  it('hides the menu when neither specialized lock option is available', () => {
    const visibility = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: false,
      showExistence: false,
      invisibleSessionUnlocked: false,
    })
    expect(isLockFilterMenuVisible(visibility)).toBe(false)
    expect(availableLockFilterOptions(visibility)).toEqual(['all'])
    expect(coerceLockFilter('secondLocked', visibility)).toBe('all')
    expect(coerceLockFilter('invisibleLocked', visibility)).toBe('all')
  })

  it('shows second locked when the session is locked and show existence is on', () => {
    const visibility = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: false,
      showExistence: true,
      invisibleSessionUnlocked: false,
    })
    expect(isLockFilterMenuVisible(visibility)).toBe(true)
    expect(availableLockFilterOptions(visibility)).toEqual(['all', 'secondLocked'])
    expect(coerceLockFilter('secondLocked', visibility)).toBe('secondLocked')
  })

  it('shows second locked when the session is unlocked even if show existence is off', () => {
    const visibility = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: true,
      showExistence: false,
      invisibleSessionUnlocked: false,
    })
    expect(isLockFilterMenuVisible(visibility)).toBe(true)
    expect(availableLockFilterOptions(visibility)).toEqual(['all', 'secondLocked'])
    expect(coerceLockFilter('secondLocked', visibility)).toBe('secondLocked')
  })

  it('hides second locked when second lock is disabled', () => {
    const visibility = resolveLockFilterVisibility({
      secondLockEnabled: false,
      secondLockSessionUnlocked: false,
      showExistence: true,
      invisibleSessionUnlocked: false,
    })
    expect(visibility.showSecondLocked).toBe(false)
    expect(isLockFilterMenuVisible(visibility)).toBe(false)
  })

  it('shows only invisible locked when the invisible session is unlocked', () => {
    const visibility = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: false,
      showExistence: false,
      invisibleSessionUnlocked: true,
    })
    expect(isLockFilterMenuVisible(visibility)).toBe(true)
    expect(availableLockFilterOptions(visibility)).toEqual(['all', 'invisibleLocked'])
    expect(coerceLockFilter('secondLocked', visibility)).toBe('all')
    expect(coerceLockFilter('invisibleLocked', visibility)).toBe('invisibleLocked')
  })

  it('shows both specialized options when both conditions are met', () => {
    const visibility = resolveLockFilterVisibility({
      secondLockEnabled: true,
      secondLockSessionUnlocked: true,
      showExistence: false,
      invisibleSessionUnlocked: true,
    })
    expect(availableLockFilterOptions(visibility)).toEqual([
      'all',
      'secondLocked',
      'invisibleLocked',
    ])
  })
})

describe('sortEntries', () => {
  const entries: TestEntry[] = [
    {
      id: 'old-edit-new',
      entry_date: sec('2026-01-01'),
      updated_at: sec('2026-05-12'),
      created_at: sec('2026-01-01'),
    },
    {
      id: 'mid',
      entry_date: sec('2026-03-01'),
      updated_at: sec('2026-03-15'),
      created_at: sec('2026-03-01'),
    },
    {
      id: 'new-edit-old',
      entry_date: sec('2026-05-01'),
      updated_at: sec('2026-05-01'),
      created_at: sec('2026-05-01'),
    },
  ]

  it('sorts newest by entry_date descending', () => {
    const out = sortEntries(entries, 'newest' satisfies SortOrder)
    expect(out.map((e) => e.id)).toEqual(['new-edit-old', 'mid', 'old-edit-new'])
  })

  it('sorts oldest by entry_date ascending', () => {
    const out = sortEntries(entries, 'oldest')
    expect(out.map((e) => e.id)).toEqual(['old-edit-new', 'mid', 'new-edit-old'])
  })

  it('sorts recently-edited by updated_at descending', () => {
    const out = sortEntries(entries, 'recentlyEdited')
    expect(out.map((e) => e.id)).toEqual(['old-edit-new', 'new-edit-old', 'mid'])
  })

  it('does not mutate the input array', () => {
    const before = entries.map((e) => e.id)
    sortEntries(entries, 'oldest')
    expect(entries.map((e) => e.id)).toEqual(before)
  })
})
