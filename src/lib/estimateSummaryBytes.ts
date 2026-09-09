export interface EstimateEntry {
  title: string | null
  content_text: string | null
  entry_date: number
}

/**
 * Conservative byte estimate of the user-message payload that will be sent
 * to the backend `summarise_entries` command. Used by the frontend to decide
 * whether to show the oversize warning modal BEFORE making the IPC call.
 *
 * Per-entry overhead covers the `## YYYY-MM-DD\n\n**title**\n\n` header and
 * the `\n\n---\n\n` separator. The constant of 64 bytes intentionally
 * over-counts a little so we warn slightly earlier; the backend remains the
 * source of truth and applies the real cap on its side.
 *
 * Uses TextEncoder for accurate UTF-8 byte counts (not .length, which
 * counts UTF-16 code units and miscounts multibyte characters).
 */
export function estimateSummaryBytes(entries: EstimateEntry[]): number {
  const encoder = new TextEncoder()
  const HEADER_OVERHEAD_BYTES = 64
  let total = 0
  for (const e of entries) {
    const title = e.title ?? 'Untitled'
    const content = e.content_text ?? ''
    total += encoder.encode(title).length
    total += encoder.encode(content).length
    total += HEADER_OVERHEAD_BYTES
  }
  return total
}
