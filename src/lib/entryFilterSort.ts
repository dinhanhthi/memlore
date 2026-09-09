/**
 * Pure filter / sort logic for the entry list filter row. Kept free of
 * Tauri, React, and i18n so it stays cheap to test.
 */

export type SortOrder = 'newest' | 'oldest' | 'recentlyEdited'

export type LockFilter = 'all' | 'secondLocked' | 'invisibleLocked'

export interface LockFilterVisibility {
  showSecondLocked: boolean
  showInvisibleLocked: boolean
}

/**
 * Whether second-lock entry signals (calendar dots, list icons, border accents)
 * may be shown. Matches when second-locked entries appear in lists/filters.
 */
export function shouldShowSecondLockEntrySignals(visibility: LockFilterVisibility): boolean {
  return visibility.showSecondLocked
}

/**
 * Whether invisible-lock entry signals may be shown. Invisible entries only
 * surface when the invisible-lock session is unlocked.
 */
export function shouldShowInvisibleLockEntrySignals(visibility: LockFilterVisibility): boolean {
  return visibility.showInvisibleLocked
}

/** Which lock-filter menu options are available given security session/settings state. */
export function resolveLockFilterVisibility(input: {
  secondLockEnabled: boolean
  secondLockSessionUnlocked: boolean
  showExistence: boolean
  invisibleSessionUnlocked: boolean
}): LockFilterVisibility {
  const showSecondLocked =
    input.secondLockEnabled && (input.secondLockSessionUnlocked || input.showExistence)

  return {
    showSecondLocked,
    showInvisibleLocked: input.invisibleSessionUnlocked,
  }
}

/** Hide the lock-filter pill when no specialized lock options can be chosen. */
export function isLockFilterMenuVisible(visibility: LockFilterVisibility): boolean {
  return visibility.showSecondLocked || visibility.showInvisibleLocked
}

export function availableLockFilterOptions(visibility: LockFilterVisibility): LockFilter[] {
  const options: LockFilter[] = ['all']
  if (visibility.showSecondLocked) options.push('secondLocked')
  if (visibility.showInvisibleLocked) options.push('invisibleLocked')
  return options
}

/** Clamp a stored lock filter to options that are currently visible. */
export function coerceLockFilter(
  lockFilter: LockFilter,
  visibility: LockFilterVisibility,
): LockFilter {
  if (!isLockFilterMenuVisible(visibility)) return 'all'
  return availableLockFilterOptions(visibility).includes(lockFilter) ? lockFilter : 'all'
}

export type TimeRange =
  | { kind: 'all' }
  | { kind: 'thisWeek' }
  | { kind: 'thisMonth' }
  | { kind: 'thisYear' }
  | { kind: 'custom'; fromDateIso: string | null; toDateIso: string | null }

export interface TimeRangeBounds {
  from: number
  toExclusive: number
}

interface ResolveOptions {
  now?: number
  firstDayOfWeek?: number
}

export function timeRangeBounds(
  range: TimeRange,
  opts: ResolveOptions = {},
): TimeRangeBounds | null {
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000)
  const now = new Date(nowSec * 1000)

  if (range.kind === 'all') return null

  if (range.kind === 'thisWeek') {
    const fdow = opts.firstDayOfWeek ?? 1
    const startOfToday = startOfDay(now)
    const offset = (startOfToday.getDay() - fdow + 7) % 7
    const start = new Date(startOfToday.getTime() - offset * MS_PER_DAY)
    const end = new Date(start.getTime() + 7 * MS_PER_DAY)
    return { from: toSec(start), toExclusive: toSec(end) }
  }

  if (range.kind === 'thisMonth') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return { from: toSec(start), toExclusive: toSec(end) }
  }

  if (range.kind === 'thisYear') {
    const start = new Date(now.getFullYear(), 0, 1)
    const end = new Date(now.getFullYear() + 1, 0, 1)
    return { from: toSec(start), toExclusive: toSec(end) }
  }

  const { fromDateIso, toDateIso } = range
  if (!fromDateIso || !toDateIso) return null
  const from = parseIsoDate(fromDateIso)
  const to = parseIsoDate(toDateIso)
  if (!from || !to) return null
  if (from.getTime() > to.getTime()) return null
  const toExclusive = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1)
  return { from: toSec(from), toExclusive: toSec(toExclusive) }
}

export function applyTimeRange<T extends { entry_date: number }>(
  entries: T[],
  range: TimeRange,
  opts: ResolveOptions = {},
): T[] {
  const bounds = timeRangeBounds(range, opts)
  if (!bounds) return entries.slice()
  return entries.filter((e) => e.entry_date >= bounds.from && e.entry_date < bounds.toExclusive)
}

export function sortEntries<T extends { entry_date: number; updated_at: number }>(
  entries: T[],
  order: SortOrder,
): T[] {
  const out = entries.slice()
  if (order === 'newest') out.sort((a, b) => b.entry_date - a.entry_date)
  else if (order === 'oldest') out.sort((a, b) => a.entry_date - b.entry_date)
  else out.sort((a, b) => b.updated_at - a.updated_at)
  return out
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function toSec(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const out = new Date(y, mo, d)
  if (out.getFullYear() !== y || out.getMonth() !== mo || out.getDate() !== d) return null
  return out
}
