/**
 * Local-calendar window for the dashboard heatmap card.
 * Use Date local getters/setters (not 24h multiples) so DST stays on calendar days.
 */

import { localDateKey } from './dashboardDates'
import { resolveFirstDayOfWeek } from './firstDayOfWeek'

/**
 * `weeks * 7` local `YYYY-MM-DD` keys ending on the last day of the week
 * containing `now`. Future days in that week are included.
 * `years` is the distinct years touched, ascending.
 * Does not mutate `now`.
 */
export function heatmapWindow(
  now: Date,
  weeks: number,
  locale: string,
): { days: string[]; years: number[] } {
  const firstWeekday = resolveFirstDayOfWeek(locale)
  const daysFromWeekStart = (now.getDay() - firstWeekday + 7) % 7
  const daysUntilWeekEnd = 6 - daysFromWeekStart

  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilWeekEnd)
  const totalDays = weeks * 7
  const cursor = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (totalDays - 1))

  const days: string[] = []
  const years: number[] = []
  for (let i = 0; i < totalDays; i++) {
    days.push(localDateKey(cursor))
    const year = cursor.getFullYear()
    if (years[years.length - 1] !== year) years.push(year)
    cursor.setDate(cursor.getDate() + 1)
  }

  return { days, years }
}
