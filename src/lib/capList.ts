/** Cap a list to `max` items while reporting the true total count.
 *
 *  Used where truncating silently would understate reality (e.g. chat
 *  source chips are a privacy disclosure of which entries reached the
 *  AI provider) — callers must render `total` somewhere so a truncated
 *  view never looks like the complete picture. */
export function capList<T>(
  items: T[],
  max: number,
): { shown: T[]; total: number; truncated: boolean } {
  return {
    shown: items.slice(0, max),
    total: items.length,
    truncated: items.length > max,
  }
}
