/** Deterministic daily index: simple string hash of `dateKey` mod `count`. */
export function dailyPromptIndex(dateKey: string, count: number): number {
  if (count <= 0) return 0
  let hash = 0
  for (let i = 0; i < dateKey.length; i++) {
    hash = (hash * 31 + dateKey.charCodeAt(i)) | 0
  }
  return ((hash % count) + count) % count
}

/**
 * Pick a different prompt index. Returns `0` when `count <= 1`.
 * `random` is injectable so tests can cover the "would have picked current" path.
 */
export function nextPromptIndex(
  current: number,
  count: number,
  random: () => number = Math.random,
): number {
  if (count <= 1) return 0
  const offset = Math.floor(random() * (count - 1)) + 1
  return (current + offset) % count
}

/** TipTap seed: escaped prompt inside a blockquote, plus a trailing empty paragraph. */
export function promptSeedHtml(prompt: string): string {
  const p = document.createElement('p')
  p.textContent = prompt
  return `<blockquote>${p.outerHTML}</blockquote><p></p>`
}
