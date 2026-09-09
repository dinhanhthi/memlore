/**
 * Minimal markdown → HTML converter for AI-generated chat drafts that
 * are seeded into the TipTap editor via `chain.setContent(html)`.
 *
 * Grammar (kept narrow on purpose — the AI's `convert_chat_to_entry`
 * prompt only emits this subset):
 *
 *   - ATX headings: `# ` / `## ` / `### `
 *   - Unordered list: lines starting with `- `, `* ` or `+ `
 *   - Ordered list:  lines starting with `<digits>. `
 *   - Paragraph:     run of non-empty lines, joined with spaces
 *   - Blank line:    paragraph / list break
 *   - Inline:        `**bold**` / `__bold__` / `*italic*` / `_italic_`
 *
 * Anything else is treated as plain text. All text content is
 * HTML-escaped — no raw-HTML escape hatch — so this can safely consume
 * untrusted model output.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  let out = ''

  type ListKind = 'ul' | 'ol'
  let listKind: ListKind | null = null
  let paragraph: string[] = []

  function flushParagraph() {
    if (paragraph.length === 0) return
    out += `<p>${renderInline(paragraph.join(' '))}</p>`
    paragraph = []
  }
  function flushList() {
    if (!listKind) return
    out += `</${listKind}>`
    listKind = null
  }

  const ulRe = /^\s*[-*+]\s+(.*)$/
  const olRe = /^\s*\d+\.\s+(.*)$/
  const headingRe = /^(#{1,3})\s+(.*)$/

  for (const raw of lines) {
    if (raw.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    const heading = raw.match(headingRe)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      out += `<h${level}>${renderInline(heading[2].trim())}</h${level}>`
      continue
    }

    const ul = raw.match(ulRe)
    if (ul) {
      flushParagraph()
      if (listKind !== 'ul') {
        flushList()
        out += '<ul>'
        listKind = 'ul'
      }
      out += `<li>${renderInline(ul[1])}</li>`
      continue
    }

    const ol = raw.match(olRe)
    if (ol) {
      flushParagraph()
      if (listKind !== 'ol') {
        flushList()
        out += '<ol>'
        listKind = 'ol'
      }
      out += `<li>${renderInline(ol[1])}</li>`
      continue
    }

    flushList()
    paragraph.push(raw.trim())
  }

  flushParagraph()
  flushList()
  return out
}

// Escape every character that is unsafe in either text or attribute
// contexts. Today the converter never emits attributes, but encoding
// `"` and `'` now removes a footgun for any future extension that
// adds links / images / `style` passthroughs.
//
// Exported as `escapeHtmlText` so the chat "Update the entry" flow
// (ChatConversation) can HTML-escape a locale-string marker before
// splicing it into the append HTML — same rule set the converter
// applies to model output, reused instead of duplicated.
export function escapeHtmlText(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;'
    if (ch === '<') return '&lt;'
    if (ch === '>') return '&gt;'
    if (ch === '"') return '&quot;'
    return '&#39;'
  })
}

/**
 * Render inline markdown (bold + italic) to HTML. Tokenises rather
 * than regex-replaces so unclosed markers degrade to plain text.
 */
function renderInline(text: string): string {
  let out = ''
  let buf = ''
  let i = 0
  const flush = () => {
    if (buf) {
      out += escapeHtmlText(buf)
      buf = ''
    }
  }
  while (i < text.length) {
    if ((text.startsWith('**', i) || text.startsWith('__', i)) && i + 4 <= text.length) {
      const marker = text.slice(i, i + 2)
      const close = text.indexOf(marker, i + 2)
      if (close > i + 2) {
        flush()
        out += `<strong>${escapeHtmlText(text.slice(i + 2, close))}</strong>`
        i = close + 2
        continue
      }
    }
    if (
      (text[i] === '*' || text[i] === '_') &&
      i + 2 <= text.length &&
      text[i + 1] !== ' ' &&
      text[i + 1] !== text[i]
    ) {
      const marker = text[i]
      const close = text.indexOf(marker, i + 1)
      if (close > i + 1 && text[close - 1] !== ' ') {
        flush()
        out += `<em>${escapeHtmlText(text.slice(i + 1, close))}</em>`
        i = close + 1
        continue
      }
    }
    buf += text[i]
    i++
  }
  flush()
  return out
}
