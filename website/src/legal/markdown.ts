import type { DiagramName } from '../docs/manifest'
import { DIAGRAMS } from '../docs/diagrams'

export type LegalMeta = {
  title: string
  description: string
  updated: string
}

export type LegalBlock =
  | { type: 'h1'; text: string }
  | { type: 'h2'; text: string; id: string }
  | { type: 'h3'; text: string; id: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'diagram'; name: DiagramName }

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

function flushList(items: string[], kind: 'ul' | 'ol', blocks: LegalBlock[]) {
  if (items.length) blocks.push({ type: kind, items: [...items] })
  items.length = 0
}

function headingId(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  const seenCount = seen.get(base) ?? 0
  seen.set(base, seenCount + 1)
  return seenCount === 0 ? base : `${base}-${seenCount + 1}`
}

function isDiagramName(name: string): name is DiagramName {
  return Object.hasOwn(DIAGRAMS, name)
}

function parseBlocks(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = []
  const paragraph: string[] = []
  const list: string[] = []
  let listKind: 'ul' | 'ol' | null = null
  const headingIds = new Map<string, number>()
  const lines = body.replace(/\r\n/g, '\n').split('\n')

  const endParagraph = () => flushParagraph(paragraph, blocks)
  const endList = () => {
    if (listKind) flushList(list, listKind, blocks)
    listKind = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      endParagraph()
      endList()
      continue
    }
    if (line.startsWith('### ')) {
      endParagraph()
      endList()
      const text = line.slice(4).trim()
      blocks.push({ type: 'h3', text, id: headingId(text, headingIds) })
      continue
    }
    if (line.startsWith('## ')) {
      endParagraph()
      endList()
      const text = line.slice(3).trim()
      blocks.push({ type: 'h2', text, id: headingId(text, headingIds) })
      continue
    }
    if (line.startsWith('# ')) {
      endParagraph()
      endList()
      blocks.push({ type: 'h1', text: line.slice(2).trim() })
      continue
    }
    const diagram = /^:::diagram (\S+)$/.exec(line.trim())
    if (diagram) {
      endParagraph()
      endList()
      const name = diagram[1]
      if (!isDiagramName(name)) throw new Error(`unknown diagram: ${name}`)
      blocks.push({ type: 'diagram', name })
      continue
    }
    if (/^- /.test(line)) {
      endParagraph()
      if (listKind === 'ol') endList()
      listKind = 'ul'
      list.push(line.slice(2).trim())
      continue
    }
    if (/^\d+\. /.test(line)) {
      endParagraph()
      if (listKind === 'ul') endList()
      listKind = 'ol'
      list.push(line.replace(/^\d+\. /, '').trim())
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

const BOLD = /\*\*([^*]+)\*\*/
const LINK = /\[([^\]]+)\]\(([^)]+)\)/

export type LegalInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'a'; text: string; href: string }

export function parseInline(text: string): LegalInline[] {
  const parts: LegalInline[] = []
  let rest = text
  while (rest) {
    const bold = BOLD.exec(rest)
    const link = LINK.exec(rest)
    const boldAt = bold ? bold.index : -1
    const linkAt = link ? link.index : -1
    if (boldAt < 0 && linkAt < 0) {
      parts.push({ type: 'text', text: rest })
      break
    }
    const useBold = boldAt >= 0 && (linkAt < 0 || boldAt < linkAt)
    const match = useBold ? bold : link
    if (!match) break
    if (match.index > 0) parts.push({ type: 'text', text: rest.slice(0, match.index) })
    if (useBold && bold) parts.push({ type: 'strong', text: bold[1] })
    else if (link) parts.push({ type: 'a', text: link[1], href: link[2] })
    rest = rest.slice(match.index + match[0].length)
  }
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
      if (part.type === 'strong') return `<strong>${escapeHtml(part.text)}</strong>`
      const external = isExternalHref(part.href) ? ' target="_blank" rel="noreferrer"' : ''
      return `<a href="${escapeHtml(part.href)}"${external}>${escapeHtml(part.text)}</a>`
    })
    .join('')
}

function renderBlock(block: LegalBlock, intro?: boolean): string {
  if (block.type === 'ul' || block.type === 'ol') {
    const tag = block.type
    return `<${tag}>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`
  }
  if (block.type === 'h1') return `<h1>${escapeHtml(block.text)}</h1>`
  if (block.type === 'h2') return `<h2 id="${escapeHtml(block.id)}">${escapeHtml(block.text)}</h2>`
  if (block.type === 'h3') return `<h3 id="${escapeHtml(block.id)}">${escapeHtml(block.text)}</h3>`
  if (block.type === 'diagram') return DIAGRAMS[block.name]
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
