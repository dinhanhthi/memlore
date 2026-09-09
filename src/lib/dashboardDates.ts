/**
 * Local-calendar helpers for dashboard cards.
 * Use Date local getters/setters (not 24h multiples) so DST stays on calendar days.
 */

/** `YYYY-MM-DD` in local time. Does not mutate `now`. */
export function localDateKey(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Unix-seconds `[start, end)` for the last 30 local calendar days, including today.
 * `end` = local midnight at the start of tomorrow (stable all calendar day).
 * `start` = a copy of that midnight with `setDate(getDate() - 30)`.
 * Does not mutate `now`.
 */
export function insightsRange(now: Date): { start: number; end: number } {
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - 30)
  return {
    start: startDate.getTime() / 1000,
    end: endDate.getTime() / 1000,
  }
}
