// NOTE: Field names are snake_case to match Rust's default serde output
// (no rename_all = "camelCase" on the backend struct).

/**
 * 7-bit weekday bitmask. bit 0 = Mon, bit 1 = Tue, … bit 6 = Sun.
 * Valid range: 1..=127. At least one day must be set.
 *
 * Examples:
 *   127 (0b1111111) — every day
 *   31  (0b0011111) — Mon–Fri
 *   64  (0b1000000) — Sunday only
 */
export type WeekdayMask = number

export const WEEKDAY_BITS = {
  Mon: 1 << 0,
  Tue: 1 << 1,
  Wed: 1 << 2,
  Thu: 1 << 3,
  Fri: 1 << 4,
  Sat: 1 << 5,
  Sun: 1 << 6,
} as const

export const ALL_WEEKDAYS_MASK: WeekdayMask = 127 // 0b1111111 — every day
export const WEEKDAYS_MASK: WeekdayMask = 31 //   0b0011111 — Mon–Fri
export const WEEKEND_MASK: WeekdayMask = 96 //    0b1100000 — Sat + Sun

export interface Reminder {
  id: string
  label: string
  /** HH:MM in local time, e.g. "09:00". */
  time_of_day: string
  weekdays: WeekdayMask
  enabled: boolean
  last_fired_at: number | null
  created_at: number
  updated_at: number
}
