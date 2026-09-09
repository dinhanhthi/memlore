/**
 * Resolve the locale's first day of the week as a `Date.getDay()` value
 * (0 = Sunday … 6 = Saturday). Uses `Intl.Locale.getWeekInfo()` when
 * available (Chromium 130+ / iOS 17+) and falls back to Monday for the
 * majority of locales, Sunday for en-US / en-CA / en-PH / ja / ko /
 * zh-TW where Sunday-first is conventional.
 *
 * Shared by the entry-list "This week" filter and `MiniDatePicker.tsx`'s
 * calendar grid so both agree on the weekday header.
 */
export function resolveFirstDayOfWeek(locale: string): number {
  try {
    type WeekInfo = { firstDay: number }
    type LocaleWithWeekInfo = Intl.Locale & {
      getWeekInfo?: () => WeekInfo
      weekInfo?: WeekInfo
    }
    const loc = new Intl.Locale(locale) as LocaleWithWeekInfo
    const info = loc.getWeekInfo?.() ?? loc.weekInfo
    if (info && typeof info.firstDay === 'number') {
      // Intl convention is 1 = Monday … 7 = Sunday — convert to JS
      // `Date.getDay()` (0 = Sunday … 6 = Saturday).
      return info.firstDay === 7 ? 0 : info.firstDay
    }
  } catch {
    // Fall through to the heuristic below.
  }
  const sundayFirstLocales = ['en-US', 'en-CA', 'en-PH', 'ja', 'ko', 'zh-TW']
  return sundayFirstLocales.some((l) => locale.toLowerCase().startsWith(l.toLowerCase())) ? 0 : 1
}
