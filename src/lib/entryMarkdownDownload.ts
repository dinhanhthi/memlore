import type { JSONContent } from '@tiptap/core'
import { save } from '@tauri-apps/plugin-dialog'

import type { Entry } from '../types/entry'
import { exportMarkdown } from './exportMarkdown'
import { isWeb } from './platform'
import {
  exportStatsFile,
  getEntry,
  getEntryContent,
  getTagsForEntry,
  listMediaForEntry,
} from './tauri'
import { snapshotToPmJson } from './yjs'

export type EntryMarkdownResult = 'saved' | 'cancelled' | 'error'

export interface EntryMarkdownInput {
  entry: Pick<Entry, 'title' | 'entry_date' | 'emotion'>
  tags: string[]
  content: JSONContent
  /** `data-media-id` → original file name. Missing ids fall back to the src's last segment. */
  mediaNames: Map<string, string>
}

const MEDIA_NODE_TYPES = new Set(['image', 'video', 'audio'])
const SLUG_MAX_LENGTH = 60

function localIsoDate(entryDate: number): string {
  const d = new Date(entryDate * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function slugify(title: string | null): string {
  const slug = (title ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '')
  return slug || 'entry'
}

/** `<YYYY-MM-DD>-<slug>.md`, the date being the entry's local calendar day. */
export function entryMarkdownFileName(title: string | null, entryDate: number): string {
  return `${localIsoDate(entryDate)}-${slugify(title)}.md`
}

/** Last path segment of a media src, decoded — never the full local or remote URL. */
function srcFileName(src: string): string {
  const path = src.split(/[?#]/)[0] ?? ''
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Malformed escapes: keep the raw path.
  }
  const segments = decoded.split(/[/\\]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  return last.includes(':') ? 'media' : last || 'media'
}

function withMediaNames(node: JSONContent, mediaNames: Map<string, string>): JSONContent {
  const next: JSONContent = { ...node }
  if (node.type && MEDIA_NODE_TYPES.has(node.type) && node.attrs) {
    const mediaId = node.attrs['data-media-id'] as string | null | undefined
    const src = (node.attrs.src as string | null | undefined) ?? ''
    const name = (mediaId && mediaNames.get(mediaId)) || srcFileName(src)
    next.attrs = { ...node.attrs, src: name }
  }
  if (node.content) next.content = node.content.map((child) => withMediaNames(child, mediaNames))
  return next
}

function frontMatter(entry: EntryMarkdownInput['entry'], tags: string[]): string {
  // Keys and formats match the Markdown importer (`split_frontmatter` in
  // src-tauri/src/commands/import.rs) so an exported entry re-imports.
  const lines = ['---']
  if (entry.title?.trim()) lines.push(`title: ${JSON.stringify(entry.title.trim())}`)
  lines.push(`date: ${new Date(entry.entry_date * 1000).toISOString().slice(0, 19)}Z`)
  if (tags.length > 0) lines.push(`tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`)
  if (entry.emotion) lines.push(`emotion: ${entry.emotion}`)
  lines.push('---')
  return lines.join('\n')
}

/** Render one entry as a standalone Markdown file: front matter, then the body. */
export function buildEntryMarkdown({
  entry,
  tags,
  content,
  mediaNames,
}: EntryMarkdownInput): string {
  const body = exportMarkdown(withMediaNames(content, mediaNames)).trimEnd()
  return `${frontMatter(entry, tags)}\n\n${body}\n`
}

function downloadBlob(markdown: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    // Deferred: Safari and Firefox can drop the download when the URL is
    // revoked in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/**
 * Export one entry as a Markdown file. Desktop: native save dialog, bytes
 * written through `export_stats_file` (the app ships no `tauri-plugin-fs`).
 * Web: Blob + `<a download>`, since the web has no save dialog.
 */
export async function downloadEntryMarkdown(entryId: string): Promise<EntryMarkdownResult> {
  try {
    const entry = await getEntry(entryId)
    if (!entry) throw new Error(`Entry ${entryId} not found`)
    const [bytes, tags, media] = await Promise.all([
      getEntryContent(entryId),
      getTagsForEntry(entryId),
      listMediaForEntry(entryId).catch(() => []),
    ])
    const content: JSONContent = bytes
      ? snapshotToPmJson(new Uint8Array(bytes))
      : { type: 'doc', content: [] }
    const markdown = buildEntryMarkdown({
      entry,
      tags: tags.map((tag) => tag.name),
      content,
      mediaNames: new Map(media.map((row) => [row.id, row.file_name])),
    })
    const fileName = entryMarkdownFileName(entry.title, entry.entry_date)

    if (isWeb) {
      downloadBlob(markdown, fileName)
      return 'saved'
    }
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (typeof path !== 'string') return 'cancelled'
    await exportStatsFile(path, new TextEncoder().encode(markdown))
    return 'saved'
  } catch (err) {
    console.error('downloadEntryMarkdown failed', err)
    return 'error'
  }
}
