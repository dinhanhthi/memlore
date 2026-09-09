/**
 * Pure date utility functions — no Tauri dependencies.
 */

import { i18n } from './i18n'

const INTL_LOCALE_MAP: Record<string, string> = {
  en: 'en-US',
  vi: 'vi-VN',
}

export function getIntlLocale(lang?: string): string {
  const l = (lang ?? i18n.language ?? 'en').toLowerCase()
  return INTL_LOCALE_MAP[l] ?? l
}

/**
 * A group label in the entry list. `'today'` and `'yesterday'` are the only
 * relative buckets; every older day is its own group keyed by the entry's
 * local ISO date (`YYYY-MM-DD`).
 */
export type DateGroup = 'today' | 'yesterday' | string

/**
 * Returns "Monday, April 14" style string from a unix timestamp (seconds).
 * entry_date is stored as Unix seconds (i64) in Rust; multiply by 1000 for JS Date.
 */
export function formatEntryDate(timestamp: number, locale?: string): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleDateString(getIntlLocale(locale), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Same as `formatEntryDate` but ALWAYS includes the year. Used in the
 * EXIF-date suggestion modal so the user can disambiguate photos taken on
 * the same calendar day across different years (e.g. anniversary photos
 * from 2022 vs 2024 should not collapse to the same label).
 */
export function formatEntryDateWithYear(timestamp: number, locale?: string): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleDateString(getIntlLocale(locale), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Human-readable label for `[start, end)` unix-second bounds (end exclusive). */
export function formatDateRange(start: number, endExclusive: number, locale?: string): string {
  if (endExclusive <= start) return formatEntryDate(start, locale)
  const endInclusive = endExclusive - 1
  const startLabel = formatEntryDateWithYear(start, locale)
  const endLabel = formatEntryDateWithYear(endInclusive, locale)
  if (startLabel === endLabel) return startLabel
  return `${startLabel} – ${endLabel}`
}

/**
 * Returns a relative label ("Today", "Yesterday", "3 days ago") or
 * falls back to formatEntryDate for older timestamps.
 */
export function formatRelativeDate(timestamp: number, locale?: string): string {
  const now = new Date()
  const date = new Date(timestamp * 1000)

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  )

  if (diffDays >= 0 && diffDays <= 6) {
    // Use 'auto' for 0/1 to get natural words ("today"/"yesterday", "Hôm nay"/"Hôm qua").
    // Use 'always' for 2-6 to get numeric output ("2 days ago", "2 ngày trước") instead of
    // locale-specific words like "Hôm kia" (vi for "the day before yesterday").
    const numeric = diffDays <= 1 ? 'auto' : 'always'
    const rtf = new Intl.RelativeTimeFormat(getIntlLocale(locale), { numeric })
    const raw = rtf.format(-diffDays, 'day')
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  }

  return formatEntryDate(timestamp, locale)
}

/**
 * Short date for dense rows (dashboard Recent entries). Today/Yesterday
 * stay localized words; 2–6 days use `Nd`; older is `Apr 4` (year only
 * when it is not the current year).
 */
export function formatCompactDate(timestamp: number, locale?: string): string {
  const now = new Date()
  const date = new Date(timestamp * 1000)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  )

  if (diffDays >= 0 && diffDays <= 1) {
    const rtf = new Intl.RelativeTimeFormat(getIntlLocale(locale), { numeric: 'auto' })
    const raw = rtf.format(-diffDays, 'day')
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  }
  if (diffDays >= 2 && diffDays <= 6) {
    return `${diffDays}d`
  }

  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric'
  return date.toLocaleDateString(getIntlLocale(locale), opts)
}

/**
 * Compact relative time for chat/Ask meta rows: `30s`, `5m`, `2h`, `3d`.
 * Falls back to `formatEntryDate` after 7 days. Unit letters are fixed (not
 * localized) so en/vi stay visually consistent in dense UI.
 *
 * Differs from `formatRelativeDate` which is day-granularity only with full
 * words ("Today", "2 days ago").
 */
export function formatFriendlyRelativeTime(timestamp: number, locale?: string): string {
  const diffSec = Math.floor((Date.now() - timestamp * 1000) / 1000)

  if (diffSec >= 86400 * 7) {
    return formatEntryDate(timestamp, locale)
  }

  // Future / clock skew → treat as just now.
  if (diffSec < 60) {
    return diffSec <= 0 ? 'now' : `${diffSec}s`
  }
  if (diffSec < 3600) {
    return `${Math.floor(diffSec / 60)}m`
  }
  if (diffSec < 86400) {
    return `${Math.floor(diffSec / 3600)}h`
  }
  return `${Math.floor(diffSec / 86400)}d`
}

/**
 * Returns a localized time string from a unix timestamp (seconds).
 *
 * `hour12` controls 12h (AM/PM) vs 24h. Defaults to 24h since that is the
 * new app-wide default; pass the user's preference from `uiStore.timeFormat`
 * to honor the setting.
 */
export function formatTime(timestamp: number, locale?: string, hour12 = false): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString(getIntlLocale(locale), {
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12,
  })
}

/**
 * Converts a unix seconds timestamp to a local "YYYY-MM-DD" string.
 * Uses local time (same as Date constructor with * 1000).
 */
export function toISODate(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parse a `YYYY-MM-DD` string into local calendar parts. Returns `null`
 * when the string is malformed or does not represent a real calendar day
 * (e.g. `2026-02-30`).
 */
export function parseISODate(iso: string): { year: number; month: number; day: number } | null {
  const m = ISO_DATE_RE.exec(iso.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return null
  const maxDay = new Date(year, month, 0).getDate()
  if (day < 1 || day > maxDay) return null
  return { year, month, day }
}

/**
 * Groups entries by day. "Today" and "Yesterday" get their special keys
 * (`'today'`, `'yesterday'`); every older day gets its own group keyed by the
 * entry's local ISO date (`YYYY-MM-DD`). Insertion order follows the input
 * order — callers should pass entries pre-sorted newest-first so the rendered
 * groups stay in reverse-chronological order.
 *
 * T must have an entry_date number field.
 */
export function groupEntriesByDate<T extends { entry_date: number }>(
  entries: T[],
): Map<DateGroup, T[]> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000)

  const groups = new Map<DateGroup, T[]>()

  for (const entry of entries) {
    const date = new Date(entry.entry_date * 1000)
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

    let key: DateGroup
    if (startOfDate.getTime() === startOfToday.getTime()) {
      key = 'today'
    } else if (startOfDate.getTime() === startOfYesterday.getTime()) {
      key = 'yesterday'
    } else {
      key = toISODate(entry.entry_date)
    }

    const group = groups.get(key)
    if (group) {
      group.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }

  return groups
}

/**
 * Formats a per-date group key (`YYYY-MM-DD`) as a human-friendly date label.
 * Includes the year when the date is not in the current year. Example output:
 *   • Same year: "Mon, May 10"
 *   • Different year: "May 10, 2025"
 */
export function formatGroupDateLabel(isoDate: string, locale?: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-')
  const year = parseInt(yStr, 10)
  const month = parseInt(mStr, 10) - 1
  const day = parseInt(dStr, 10)
  const date = new Date(year, month, day)
  const currentYear = new Date().getFullYear()

  if (year === currentYear) {
    return date.toLocaleDateString(getIntlLocale(locale), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  return date.toLocaleDateString(getIntlLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
