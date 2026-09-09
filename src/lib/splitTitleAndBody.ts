/**
 * Split a markdown chat draft into a title and body for entry creation.
 *
 * The AI's `convert_chat_to_entry` prompt is supposed to emit a leading
 * `# Title` heading, in which case the heading line becomes the title
 * and is stripped from the body. When the model skips the heading we
 * fall back to the first non-empty line, truncated to a sensible
 * length — but only if there is *also* further content to use as the
 * body. A single-line draft keeps the line as the body and leaves the
 * title null, otherwise the entry would open empty.
 *
 * `title` is `null` only when the input has no usable title source
 * (empty / whitespace-only input, or the single-line fallback case).
 */
export const TITLE_FALLBACK_MAX_LEN = 60

export function splitTitleAndBody(markdown: string): { title: string | null; body: string } {
  const lines = markdown.split(/\r?\n/)

  const h1Idx = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (h1Idx !== -1) {
    const title = lines[h1Idx].replace(/^#\s+/, '').trim()
    const before = lines.slice(0, h1Idx).join('\n').trim()
    const after = lines
      .slice(h1Idx + 1)
      .join('\n')
      .trim()
    const body = [before, after].filter(Boolean).join('\n\n')
    return { title: title || null, body }
  }

  const fallbackIdx = lines.findIndex((l) => l.trim() !== '')
  if (fallbackIdx === -1) {
    return { title: null, body: markdown.trim() }
  }
  const rawLine = lines[fallbackIdx].trim()
  const after = lines
    .slice(fallbackIdx + 1)
    .join('\n')
    .trim()

  // Single-line draft (no heading, no further content): keep the line
  // as the body so the entry isn't created empty. Otherwise promote
  // the line to a title and strip it from the body.
  if (after === '') {
    return { title: null, body: rawLine }
  }

  const title =
    rawLine.length > TITLE_FALLBACK_MAX_LEN
      ? rawLine.slice(0, TITLE_FALLBACK_MAX_LEN).trimEnd() + '…'
      : rawLine
  return { title: title || null, body: after }
}
