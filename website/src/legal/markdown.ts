export type LegalMeta = {
  title: string
  description: string
  updated: string
}

export type LegalBlock =
  | { type: 'h1' | 'h2'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }

export type LegalDoc = {
  meta: LegalMeta
  blocks: LegalBlock[]
}

const REQUIRED_META = ['title', 'description', 'updated'] as const

function parseFrontmatter(source: string): { meta: LegalMeta; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) throw new Error('legal markdown is missing YAML frontmatter')
  const raw: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const sep = line.indexOf(':')
    if (sep < 1) throw new Error(`invalid frontmatter line: ${line}`)
    raw[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
  }
  for (const key of REQUIRED_META) {
    if (!raw[key]) throw new Error(`legal markdown frontmatter missing ${key}`)
  }
  return {
    meta: {
      title: raw.title,
      description: raw.description,
      updated: raw.updated,
    },
    body: source.slice(match[0].length),
  }
}

function flushParagraph(lines: string[], blocks: LegalBlock[]) {
  const text = lines.join(' ').trim()
  if (text) blocks.push({ type: 'p', text })
  lines.length = 0
}

function flushList(items: string[], blocks: LegalBlock[]) {
  if (items.length) blocks.push({ type: 'ul', items: [...items] })
  items.length = 0
}

function parseBlocks(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = []
  const paragraph: string[] = []
  const list: string[] = []
  const lines = body.replace(/\r\n/g, '\n').split('\n')

  const endParagraph = () => flushParagraph(paragraph, blocks)
  const endList = () => flushList(list, blocks)

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      endParagraph()
      endList()
      continue
    }
    if (line.startsWith('## ')) {
      endParagraph()
      endList()
      blocks.push({ type: 'h2', text: line.slice(3).trim() })
      continue
    }
    if (line.startsWith('# ')) {
      endParagraph()
      endList()
      blocks.push({ type: 'h1', text: line.slice(2).trim() })
      continue
    }
    if (/^- /.test(line)) {
      endParagraph()
      list.push(line.slice(2).trim())
      continue
    }
    endList()
    paragraph.push(line.trim())
  }
  endParagraph()
  endList()
  return blocks
}

export function parseLegalMarkdown(source: string): LegalDoc {
  const { meta, body } = parseFrontmatter(source)
  return { meta, blocks: parseBlocks(body) }
}

const LINK = /\[([^\]]+)\]\(([^)]+)\)/g

export type LegalInline = { type: 'text'; text: string } | { type: 'a'; text: string; href: string }

export function parseInline(text: string): LegalInline[] {
  const parts: LegalInline[] = []
  let last = 0
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0
    if (start > last) parts.push({ type: 'text', text: text.slice(last, start) })
    parts.push({ type: 'a', text: match[1], href: match[2] })
    last = start + match[0].length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts.length ? parts : [{ type: 'text', text }]
}

export function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://')
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderInline(text: string): string {
  return parseInline(text)
    .map((part) => {
      if (part.type === 'text') return escapeHtml(part.text)
      const external = isExternalHref(part.href) ? ' target="_blank" rel="noreferrer"' : ''
      return `<a href="${escapeHtml(part.href)}"${external}>${escapeHtml(part.text)}</a>`
    })
    .join('')
}

function renderBlock(block: LegalBlock, intro?: boolean): string {
  if (block.type === 'ul') {
    return `<ul>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`
  }
  if (block.type === 'h1') return `<h1>${escapeHtml(block.text)}</h1>`
  if (block.type === 'h2') return `<h2>${escapeHtml(block.text)}</h2>`
  return `<p${intro ? ' class="legal-intro"' : ''}>${renderInline(block.text)}</p>`
}

/**
 * Server-side twin of LegalPage's <article>, injected into the page shell at
 * build time. Google's OAuth verification reviewer fetches the raw HTML and does
 * not execute JS — without this the privacy policy reads as an empty page and
 * publishing is rejected for "insufficient content".
 */
export function renderLegalStaticHtml(source: string): string {
  const { meta, blocks } = parseLegalMarkdown(source)
  const heading = blocks.find((block) => block.type === 'h1')
  const rest = heading ? blocks.filter((block) => block !== heading) : blocks
  const firstParagraph = rest.findIndex((block) => block.type === 'p')
  return [
    '<main id="main"><article class="legal-article">',
    heading ? renderBlock(heading) : '',
    `<p class="legal-updated">${escapeHtml(`Last updated ${meta.updated}`)}</p>`,
    ...rest.map((block, index) => renderBlock(block, index === firstParagraph)),
    '</article></main>',
  ].join('')
}
