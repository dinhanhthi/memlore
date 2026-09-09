export type PageWindowItem = number | 'ellipsis-left' | 'ellipsis-right'

export interface PageWindowOpts {
  siblings?: number // pages on each side of current (default 1)
  boundaries?: number // pages pinned at the start and end (default 1)
}

/**
 * Build a windowed page list for a numbered pager: e.g. for current=5,
 * total=11 returns [1, 'ellipsis-left', 4, 5, 6, 'ellipsis-right', 11].
 *
 * Defaults match the visual spec `< 1 2 … 5 … 10 11 >`.
 * - total <= 1 → [1]
 * - When the natural window (boundaries on each side + siblings*2 + current
 *   + 2 ellipses) fully spans `total`, no ellipses are inserted and the
 *   full 1..total range is returned.
 * - `current` is clamped into [1, max(1, total)] before windowing.
 */
export function paginationWindow(
  current: number,
  total: number,
  opts: PageWindowOpts = {},
): PageWindowItem[] {
  const totalClamped = Math.max(0, Math.floor(total))

  if (totalClamped <= 1) return [1]

  const currentClamped = Math.min(Math.max(1, Math.floor(current)), totalClamped)

  const siblings = Math.max(0, opts.siblings ?? 1)
  const boundaries = Math.max(0, opts.boundaries ?? 1)

  // Natural slot count: boundary pages on each side + 2 siblings + current + 2 ellipsis slots
  const slotCount = boundaries * 2 + siblings * 2 + 3

  // If the total fits within the natural window, return the full range without ellipses
  if (totalClamped <= slotCount) {
    return Array.from({ length: totalClamped }, (_, i) => i + 1)
  }

  // Non-boundary inner zone
  const innerStart = boundaries + 1
  const innerEnd = totalClamped - boundaries

  // Initial sibling window, clamped to the inner zone
  let windowStart = Math.max(currentClamped - siblings, innerStart)
  let windowEnd = Math.min(currentClamped + siblings, innerEnd)

  // Compensate for truly invalid pages (below 1 or above total) by extending
  // the window in the opposite direction. Boundary pages that cover the sibling
  // zone do NOT trigger compensation — they are already shown.
  const leftInvalidClip = Math.max(0, 1 - (currentClamped - siblings))
  if (leftInvalidClip > 0) {
    windowEnd = Math.min(windowEnd + leftInvalidClip, innerEnd)
  }

  const rightInvalidClip = Math.max(0, currentClamped + siblings - totalClamped)
  if (rightInvalidClip > 0) {
    windowStart = Math.max(windowStart - rightInvalidClip, innerStart)
  }

  // An ellipsis is needed when there's a gap between the boundary and the window
  const hasLeftEllipsis = windowStart > innerStart
  const hasRightEllipsis = windowEnd < innerEnd

  const result: PageWindowItem[] = []

  // Left boundary pages: 1..boundaries
  result.push(...range(1, boundaries))

  if (hasLeftEllipsis) {
    result.push('ellipsis-left')
  } else {
    // Fill the gap between left boundary and window start (may be empty)
    result.push(...range(boundaries + 1, windowStart - 1))
  }

  result.push(...range(windowStart, windowEnd))

  if (hasRightEllipsis) {
    result.push('ellipsis-right')
  } else {
    // Fill the gap between window end and right boundary start (may be empty)
    result.push(...range(windowEnd + 1, totalClamped - boundaries))
  }

  // Right boundary pages: (total - boundaries + 1)..total
  result.push(...range(totalClamped - boundaries + 1, totalClamped))

  return result
}

/** Inclusive range from `start` to `end`. Returns [] if start > end. */
function range(start: number, end: number): number[] {
  if (start > end) return []
  return Array.from({ length: end - start + 1 }, (_, i) => start + i)
}
