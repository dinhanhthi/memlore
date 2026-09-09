/**
 * Pure date/time formatters for editor slash commands.
 * Language follows the UI locale: en → YYYY-MM-DD, vi → DD-MM-YYYY.
 */

import { getIntlLocale } from './dates'

export function isVietnameseUiLanguage(lang: string): boolean {
  return lang.toLowerCase().startsWith('vi')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatSlashDate(date: Date, lang: string): string {
  const year = date.getFullYear()
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  if (isVietnameseUiLanguage(lang)) {
    return `${day}-${month}-${year}`
  }
  return `${year}-${month}-${day}`
}

export function formatSlashWeekday(date: Date, lang: string): string {
  return date.toLocaleDateString(getIntlLocale(lang), { weekday: 'long' })
}

export function formatSlashDateFull(date: Date, lang: string): string {
  return `${formatSlashWeekday(date, lang)}, ${formatSlashDate(date, lang)}`
}

export function formatSlashTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function formatSlashNow(date: Date, lang: string): string {
  return `${formatSlashDate(date, lang)} ${formatSlashTime(date)}`
}

/** New Date shifted by local calendar days via setDate (DST-safe). Does not mutate `date`. */
export function shiftLocalDate(date: Date, days: number): Date {
  const shifted = new Date(date)
  shifted.setDate(shifted.getDate() + days)
  return shifted
}
