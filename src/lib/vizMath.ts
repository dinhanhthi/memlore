/** Pure geometry and label helpers for the story-in-numbers tiles. */

export function normalize(values: number[], maxPx: number): number[] {
  const clamped = values.map((value) => Math.max(0, value))
  const max = clamped.reduce((peak, value) => Math.max(peak, value), 0)
  if (max === 0) return clamped.map(() => 0)
  return clamped.map((value) => (value / max) * maxPx)
}

export function sparklinePoints(values: number[], w: number, h: number, pad: number): string {
  if (values.length === 0) return ''
  const heights = normalize(values, h - 2 * pad)
  // One value still needs two endpoints so the polyline is a horizontal line.
  const indexes = values.length === 1 ? [0, 0] : values.map((_, index) => index)
  return indexes
    .map((valueIndex, pointIndex) => {
      const x = pad + ((w - 2 * pad) * pointIndex) / (indexes.length - 1)
      const y = h - pad - heights[valueIndex]
      return `${formatCoord(x)},${formatCoord(y)}`
    })
    .join(' ')
}

export function peakHour(rows: { hour: number; count: number }[]): number | null {
  let best: { hour: number; count: number } | null = null
  for (const row of rows) {
    if (row.count <= 0) continue
    const laterTie = best !== null && row.count === best.count && row.hour > best.hour
    if (best === null || row.count > best.count || laterTie) best = row
  }
  return best?.hour ?? null
}

/** `hour: 'numeric'` lets the locale pick the cycle: en is 12-hour, vi is h23. */
export function formatHour(hour: number, locale: string): string {
  const date = new Date(2000, 0, 1, hour, 0, 0, 0)
  return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).format(date)
}

/**
 * Integer percentages via the largest-remainder method.
 * Equal fractional parts break toward the earlier mood: good, then neutral, then bad.
 * All-zero input stays `{0,0,0}` and is the only result that does not sum to 100.
 */
export function moodSplit(counts: { good: number; neutral: number; bad: number }): {
  good: number
  neutral: number
  bad: number
} {
  const raw = [counts.good, counts.neutral, counts.bad]
  const total = raw.reduce((sum, count) => sum + count, 0)
  if (total === 0) return { good: 0, neutral: 0, bad: 0 }

  const exact = raw.map((count) => (count / total) * 100)
  const shares = exact.map((value) => Math.floor(value))
  let leftover = 100 - shares.reduce((sum, share) => sum + share, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)

  for (const slot of byRemainder) {
    if (leftover <= 0) break
    shares[slot.index] += 1
    leftover -= 1
  }

  const [good = 0, neutral = 0, bad = 0] = shares
  return { good, neutral, bad }
}

export function ringFraction(value: number, goal: number): number {
  if (goal <= 0 || value < 0) return 0
  return Math.min(1, value / goal)
}

function formatCoord(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}
