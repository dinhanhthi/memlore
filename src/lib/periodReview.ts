import { resolveFirstDayOfWeek } from './firstDayOfWeek'
import type { PeriodReviewKind } from '../types/ai'

/** Unix seconds at local midnight for the given calendar day. */
export function localMidnight(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000)
}

/** Start of the ISO-style week containing `anchor` (locale first-day aware). */
export function weekRangeContaining(
  anchorSec: number,
  locale?: string,
): { start: number; end: number } {
  const anchor = new Date(anchorSec * 1000)
  const firstDay = resolveFirstDayOfWeek(locale ?? 'en')
  const day = anchor.getDay()
  const delta = (day - firstDay + 7) % 7
  const startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - delta)
  const endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7)
  return {
    start: Math.floor(startDate.getTime() / 1000),
    end: Math.floor(endDate.getTime() / 1000),
  }
}

/** Calendar month containing `anchor`, `[start, end)` bounds. */
export function monthRangeContaining(anchorSec: number): { start: number; end: number } {
  const anchor = new Date(anchorSec * 1000)
  const startDate = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const endDate = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)
  return {
    start: Math.floor(startDate.getTime() / 1000),
    end: Math.floor(endDate.getTime() / 1000),
  }
}

export function periodRange(
  kind: PeriodReviewKind,
  anchorSec: number,
  locale?: string,
): { start: number; end: number } {
  return kind === 'weekly'
    ? weekRangeContaining(anchorSec, locale)
    : monthRangeContaining(anchorSec)
}

export function shiftPeriodAnchor(
  kind: PeriodReviewKind,
  anchorSec: number,
  delta: -1 | 1,
  locale?: string,
): number {
  const { start, end } = periodRange(kind, anchorSec, locale)
  const span = end - start
  return anchorSec + delta * span
}
