import { Fragment, type ReactNode } from 'react'

/**
 * Minimal markdown-to-React renderer for AI-generated bullet content
 * (Phase 6 v2 R7+). The system prompts that drive entry highlights /
 * go-deeper / multi-entry summary constrain output to short bullet
 * lists with optional bold / italic emphasis. A full markdown library
 * would add ~30KB for a feature surface that uses ~5% of the grammar.
 *
 * Supported:
 * - ATX headings `# ` … `###### ` → `<h1>` … `<h6>` with Tailwind sizing.
 * - Bullet lines starting with `- `, `* `, or `+ ` → rendered as
 *   `<li>` inside a `<ul>`.
 * - Numbered lines starting with `1. ` (any digits) → also `<li>`.
 * - `**bold**` / `__bold__` → `<strong>`.
 * - `*italic*` / `_italic_` → `<em>`.
 * - Blank lines separate paragraphs.
 * - Single newlines inside a paragraph become `<br />` so the preview
 *   preserves the writer's line breaks instead of collapsing them.
 *
 * Streaming-friendly: re-rendered on every token. Partial markdown
 * (e.g. an open `**` with no closer yet) is rendered literally — no
 * exception, no broken layout.
 *
 * Safety: the renderer only produces React element trees with text
 * leaves — no raw-HTML escape hatch — so XSS via markdown injection is
 * structurally impossible regardless of the model's output.
 */
const HEADING_CLASSES: Record<number, string> = {
  1: 'mb-2 text-xl font-semibold leading-tight',
  2: 'mb-2 text-lg font-semibold leading-tight',
  3: 'mb-1 text-base font-semibold leading-snug',
  4: 'mb-1 text-sm font-semibold leading-snug',
  5: 'mb-1 text-sm font-semibold leading-snug',
  6: 'mb-1 text-xs font-semibold uppercase tracking-wide',
}

export interface SimpleMarkdownOptions {
  /**
   * Render an `[id=…]` entry reference the model echoed out of its journal
   * context block. Chat passes a clickable badge; every other surface omits
   * this and the marker renders literally, exactly as before.
   *
   * Why this is opt-in rather than always-on: only Daily Chat feeds entry
   * ids to a model, so only Daily Chat can resolve one back to a title.
   * A shared default would either strip meaningful text elsewhere or need
   * a lookup the other callers cannot supply.
   */
  renderEntryRef?: (entryId: string) => ReactNode
}

export function renderSimpleMarkdown(text: string, options?: SimpleMarkdownOptions): ReactNode {
  const lines = text.split(/\r?\n/)
  const blocks: ReactNode[] = []
  let bulletBuffer: string[] = []
  let paragraphBuffer: string[] = []
  let blockKey = 0

  function flushBullets() {
    if (bulletBuffer.length === 0) return
    const items = bulletBuffer.map((line, i) => (
      <li key={i} className="leading-relaxed">
        {renderInline(line, options)}
      </li>
    ))
    blocks.push(
      <ul key={`b${blockKey++}`} className="ml-5 list-disc space-y-1">
        {items}
      </ul>,
    )
    bulletBuffer = []
  }
  function flushParagraph() {
    if (paragraphBuffer.length === 0) return
    const children: ReactNode[] = []
    paragraphBuffer.forEach((line, i) => {
      if (i > 0) children.push(<br key={`br${i}`} />)
      children.push(<Fragment key={`f${i}`}>{renderInline(line, options)}</Fragment>)
    })
    blocks.push(
      <p key={`p${blockKey++}`} className="leading-relaxed">
        {children}
      </p>,
    )
    paragraphBuffer = []
  }
  function pushHeading(level: number, content: string) {
    flushBullets()
    flushParagraph()
    const className = HEADING_CLASSES[level] ?? HEADING_CLASSES[6]
    const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    blocks.push(
      <Tag key={`h${blockKey++}`} className={className}>
        {renderInline(content, options)}
      </Tag>,
    )
  }

  const headingRe = /^\s*(#{1,6})\s+(.*)$/
  const bulletRe = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      flushBullets()
      flushParagraph()
      continue
    }
    const headingMatch = raw.match(headingRe)
    if (headingMatch && headingMatch[1] && headingMatch[2] !== undefined) {
      pushHeading(headingMatch[1].length, headingMatch[2].trim())
      continue
    }
    const match = raw.match(bulletRe)
    if (match && match[1] !== undefined) {
      flushParagraph()
      bulletBuffer.push(match[1])
    } else {
      flushBullets()
      paragraphBuffer.push(line)
    }
  }
  flushBullets()
  flushParagraph()
  return <>{blocks}</>
}

/// Inline grammar: `**bold**` / `__bold__` / `*italic*` / `_italic_`.
/// Tokenise rather than regex-replace so partial markers (a stream in
/// progress) render as plain text instead of breaking.
function renderInline(text: string, options?: SimpleMarkdownOptions): ReactNode {
  const tokens = tokeniseInline(text)
  return tokens.map((tok, i) => {
    switch (tok.kind) {
      case 'text':
        return <Fragment key={i}>{tok.value}</Fragment>
      case 'bold':
        return <strong key={i}>{tok.value}</strong>
      case 'italic':
        return <em key={i}>{tok.value}</em>
      case 'entryRef': {
        // No renderer supplied → the marker is just text, byte-for-byte
        // what the model wrote. Never silently swallowed: a caller that
        // cannot resolve ids showing nothing would drop a sentence's
        // subject.
        const rendered = options?.renderEntryRef?.(tok.value)
        return rendered === undefined || rendered === null ? (
          <Fragment key={i}>{`[id=${tok.value}]`}</Fragment>
        ) : (
          <Fragment key={i}>{rendered}</Fragment>
        )
      }
    }
  })
}

interface InlineToken {
  kind: 'text' | 'bold' | 'italic' | 'entryRef'
  value: string
}

/** `[id=<entry-id>]` — the citation marker `build_entry_context_block`
 *  puts on each entry it feeds the model. Models routinely echo it into
 *  their prose, where a raw UUID is meaningless to the reader.
 *
 *  Anchored to the id charset (hex/UUID for real entries, short slugs in
 *  tests) rather than "anything up to the next `]`", so ordinary bracketed
 *  prose that happens to contain `id=` is left alone. */
const ENTRY_REF_RE = /^\[id=([A-Za-z0-9_-]+)\]/

function tokeniseInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let i = 0
  let buf = ''
  while (i < text.length) {
    if (text[i] === '[') {
      const match = text.slice(i).match(ENTRY_REF_RE)
      if (match && match[1]) {
        if (buf) {
          out.push({ kind: 'text', value: buf })
          buf = ''
        }
        out.push({ kind: 'entryRef', value: match[1] })
        i += match[0].length
        continue
      }
    }
    if ((text.startsWith('**', i) || text.startsWith('__', i)) && i + 4 <= text.length) {
      const marker = text.slice(i, i + 2)
      const close = text.indexOf(marker, i + 2)
      if (close > i + 2) {
        if (buf) {
          out.push({ kind: 'text', value: buf })
          buf = ''
        }
        out.push({ kind: 'bold', value: text.slice(i + 2, close) })
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
        if (buf) {
          out.push({ kind: 'text', value: buf })
          buf = ''
        }
        out.push({ kind: 'italic', value: text.slice(i + 1, close) })
        i = close + 1
        continue
      }
    }
    buf += text[i]
    i++
  }
  if (buf) out.push({ kind: 'text', value: buf })
  return out
}
