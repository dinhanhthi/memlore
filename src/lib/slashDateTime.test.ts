import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatSlashDate,
  formatSlashDateFull,
  formatSlashNow,
  formatSlashTime,
  formatSlashWeekday,
  isVietnameseUiLanguage,
  shiftLocalDate,
} from './slashDateTime'

/** Monday, 13 April 2026 at 14:30 local — weekday + padding + afternoon time. */
const PINNED = new Date(2026, 3, 13, 14, 30, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(PINNED)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isVietnameseUiLanguage', () => {
  it('is true for vi, vi-VN, and VI (case-insensitive vi prefix)', () => {
    expect(isVietnameseUiLanguage('vi')).toBe(true)
    expect(isVietnameseUiLanguage('vi-VN')).toBe(true)
    expect(isVietnameseUiLanguage('VI')).toBe(true)
  })

  it('is false for English, empty, and unknown languages', () => {
    expect(isVietnameseUiLanguage('en')).toBe(false)
    expect(isVietnameseUiLanguage('en-US')).toBe(false)
    expect(isVietnameseUiLanguage('')).toBe(false)
    expect(isVietnameseUiLanguage('fr')).toBe(false)
  })
})

describe('formatSlashDate', () => {
  it('formats English UI as zero-padded YYYY-MM-DD', () => {
    expect(formatSlashDate(PINNED, 'en')).toBe('2026-04-13')
  })

  it('formats Vietnamese UI as zero-padded DD-MM-YYYY', () => {
    expect(formatSlashDate(PINNED, 'vi')).toBe('13-04-2026')
  })

  it('zero-pads January 5 in both languages', () => {
    const jan5 = new Date(2026, 0, 5, 9, 0, 0)
    expect(formatSlashDate(jan5, 'en')).toBe('2026-01-05')
    expect(formatSlashDate(jan5, 'vi')).toBe('05-01-2026')
  })
})

describe('formatSlashWeekday', () => {
  it('returns the long English weekday', () => {
    expect(formatSlashWeekday(PINNED, 'en')).toBe('Monday')
  })

  it('returns the long Vietnamese weekday', () => {
    // ICU casing of "Thứ Hai" can vary; pin the weekday token like dates.test.ts.
    expect(formatSlashWeekday(PINNED, 'vi')).toMatch(/Thứ/)
  })
})

describe('formatSlashDateFull', () => {
  it('joins weekday and date for English UI', () => {
    expect(formatSlashDateFull(PINNED, 'en')).toBe('Monday, 2026-04-13')
  })

  it('joins weekday and date for Vietnamese UI', () => {
    expect(formatSlashDateFull(PINNED, 'vi')).toMatch(/Thứ.*, 13-04-2026/)
  })
})

describe('formatSlashTime', () => {
  it('formats afternoon as local 24-hour HH:MM without seconds', () => {
    expect(formatSlashTime(PINNED)).toBe('14:30')
  })

  it('formats midnight as 00:00', () => {
    const midnight = new Date(2026, 3, 14, 0, 0, 0)
    expect(formatSlashTime(midnight)).toBe('00:00')
  })
})

describe('formatSlashNow', () => {
  it('joins English date and time without a weekday', () => {
    expect(formatSlashNow(PINNED, 'en')).toBe('2026-04-13 14:30')
  })

  it('joins Vietnamese date and time without a weekday', () => {
    expect(formatSlashNow(PINNED, 'vi')).toBe('13-04-2026 14:30')
  })
})

describe('shiftLocalDate', () => {
  it('returns yesterday and tomorrow without mutating the input', () => {
    const originalMs = PINNED.getTime()
    const yesterday = shiftLocalDate(PINNED, -1)
    const tomorrow = shiftLocalDate(PINNED, 1)

    expect(yesterday.getFullYear()).toBe(2026)
    expect(yesterday.getMonth()).toBe(3)
    expect(yesterday.getDate()).toBe(12)
    expect(tomorrow.getDate()).toBe(14)
    expect(PINNED.getTime()).toBe(originalMs)
    expect(yesterday).not.toBe(PINNED)
  })

  it('wraps yesterday from 1 March 2026 onto 28 February', () => {
    const mar1 = new Date(2026, 2, 1, 10, 0, 0)
    const feb28 = shiftLocalDate(mar1, -1)
    expect(feb28.getFullYear()).toBe(2026)
    expect(feb28.getMonth()).toBe(1)
    expect(feb28.getDate()).toBe(28)
  })

  it('wraps yesterday from 1 March 2024 onto leap-day 29 February', () => {
    const mar1 = new Date(2024, 2, 1, 10, 0, 0)
    const feb29 = shiftLocalDate(mar1, -1)
    expect(feb29.getFullYear()).toBe(2024)
    expect(feb29.getMonth()).toBe(1)
    expect(feb29.getDate()).toBe(29)
  })
})
