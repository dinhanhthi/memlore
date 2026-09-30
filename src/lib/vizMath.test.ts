import { describe, expect, it } from 'vitest'
import {
  formatHour,
  moodSplit,
  normalize,
  peakHour,
  ringFraction,
  sparklinePoints,
} from './vizMath'

describe('normalize', () => {
  it('scales values so the largest lands on maxPx', () => {
    expect(normalize([0, 5, 10], 20)).toEqual([0, 10, 20])
  })

  it('returns an empty array when there are no values', () => {
    expect(normalize([], 40)).toEqual([])
  })

  it('returns zeros when every value is zero', () => {
    expect(normalize([0, 0, 0], 40)).toEqual([0, 0, 0])
  })

  it('clamps negative values to zero before scaling', () => {
    expect(normalize([-10, 5], 10)).toEqual([0, 10])
  })

  it('returns zeros when every value clamps to zero', () => {
    expect(normalize([-4, -1], 10)).toEqual([0, 0])
  })
})

describe('sparklinePoints', () => {
  it('returns an empty string when there are no values', () => {
    expect(sparklinePoints([], 100, 40, 4)).toBe('')
  })

  it('draws one positive value as a flat line along the top of the padded box', () => {
    expect(sparklinePoints([8], 100, 40, 4)).toBe('4,4 96,4')
  })

  it('draws one zero as a flat line along the bottom of the padded box', () => {
    expect(sparklinePoints([0], 100, 40, 4)).toBe('4,36 96,36')
  })

  it('spaces two or more points from pad to width minus pad', () => {
    const xs = sparklinePoints([2, 4, 2], 110, 30, 5)
      .split(' ')
      .map((point) => point.split(',')[0])
    expect(xs).toEqual(['5', '55', '105'])
  })

  it('maps a larger value to a smaller svg y', () => {
    const ys = sparklinePoints([0, 10], 100, 40, 4)
      .split(' ')
      .map((point) => Number(point.split(',')[1]))
    expect(ys[1]).toBeLessThan(ys[0] ?? 0)
  })

  it('keeps a smaller positive value above the bottom when zero is the baseline', () => {
    expect(sparklinePoints([10, 20], 100, 40, 4)).toBe('4,20 96,4')
  })

  it('draws a flat bottom line when every value is zero', () => {
    expect(sparklinePoints([0, 0], 100, 40, 4)).toBe('4,36 96,36')
  })

  it('keeps every point inside the padded box', () => {
    const w = 100
    const h = 40
    const pad = 4
    const points = sparklinePoints([1, 4, 2, 0], w, h, pad)
    for (const pair of points.split(' ')) {
      const [x, y] = pair.split(',').map(Number)
      expect(x).toBeGreaterThanOrEqual(pad)
      expect(x).toBeLessThanOrEqual(w - pad)
      expect(y).toBeGreaterThanOrEqual(pad)
      expect(y).toBeLessThanOrEqual(h - pad)
    }
  })
})

describe('peakHour', () => {
  it('returns the hour with the highest count', () => {
    expect(
      peakHour([
        { hour: 8, count: 1 },
        { hour: 21, count: 4 },
        { hour: 14, count: 2 },
      ]),
    ).toBe(21)
  })

  it('returns null when there are no rows', () => {
    expect(peakHour([])).toBeNull()
  })

  it('returns null when every count is zero', () => {
    expect(
      peakHour([
        { hour: 0, count: 0 },
        { hour: 15, count: 0 },
      ]),
    ).toBeNull()
  })

  it('resolves a tie to the highest hour number', () => {
    expect(
      peakHour([
        { hour: 9, count: 3 },
        { hour: 3, count: 3 },
        { hour: 18, count: 3 },
      ]),
    ).toBe(18)
  })
})

describe('formatHour', () => {
  it('formats 21 in English as 9 PM', () => {
    const formatted = formatHour(21, 'en')
    expect(formatted).toContain('9')
    expect(formatted.toLowerCase()).toContain('pm')
  })

  it('formats 21 in Vietnamese as a 24-hour time', () => {
    const formatted = formatHour(21, 'vi')
    expect(formatted).toContain('21')
    expect(formatted.toLowerCase()).not.toMatch(/am|pm/)
  })
})

describe('moodSplit', () => {
  it('returns zeros when every count is zero', () => {
    expect(moodSplit({ good: 0, neutral: 0, bad: 0 })).toEqual({
      good: 0,
      neutral: 0,
      bad: 0,
    })
  })

  it('gives the whole share to the only mood that was recorded', () => {
    expect(moodSplit({ good: 4, neutral: 0, bad: 0 })).toEqual({
      good: 100,
      neutral: 0,
      bad: 0,
    })
  })

  it('assigns leftover percentage points by the largest remainder', () => {
    // 2/7, 2/7, 3/7 → floors 28+28+42=98; the two extras go to bad, then good.
    expect(moodSplit({ good: 2, neutral: 2, bad: 3 })).toEqual({
      good: 29,
      neutral: 28,
      bad: 43,
    })
  })

  it('breaks an even remainder tie toward the earlier mood', () => {
    expect(moodSplit({ good: 1, neutral: 1, bad: 1 })).toEqual({
      good: 34,
      neutral: 33,
      bad: 33,
    })
  })
})

describe('ringFraction', () => {
  it('returns value divided by goal', () => {
    expect(ringFraction(5, 10)).toBe(0.5)
  })

  it('clamps a value past the goal to 1', () => {
    expect(ringFraction(15, 10)).toBe(1)
  })

  it('returns 1 when value equals the goal', () => {
    expect(ringFraction(10, 10)).toBe(1)
  })

  it('returns 0 when the goal is zero', () => {
    expect(ringFraction(4, 0)).toBe(0)
  })

  it('returns 0 when the goal is negative', () => {
    expect(ringFraction(4, -2)).toBe(0)
  })

  it('returns 0 when the value is negative', () => {
    expect(ringFraction(-3, 10)).toBe(0)
  })
})
