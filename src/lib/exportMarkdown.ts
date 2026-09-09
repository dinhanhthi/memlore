import type { JSONContent } from '@tiptap/core'

// ─── Mark rendering ───────────────────────────────────────────────────────────

function applyMarks(raw: string, marks: JSONContent['marks']): string {
  if (!marks || marks.length === 0) return raw
  // Collapse bold+italic into ***…*** before applying individually.
  const hasBold = marks.some((m) => m.type === 'bold')
  const hasItalic = marks.some((m) => m.type === 'italic')
  let result = raw
  if (hasBold && hasItalic) {
    result = `***${result}***`
  } else if (hasBold) {
    result = `**${result}**`
  } else if (hasItalic) {
    result = `*${result}*`
  }
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
      case 'italic':
        // already handled above
        break
      case 'strike':
        result = `~~${result}~~`
        break
      case 'code':
        result = `\`${result}\``
        break
      case 'link': {
        const href = (mark.attrs?.href as string | null) ?? '#'
        result = `[${result}](${href})`
        break
      }
      // underline has no standard MD equivalent; pass through
    }
  }
  return result
}

// ─── Inline content (text + inline nodes) ────────────────────────────────────

function renderInline(nodes: JSONContent[] | undefined): string {
  if (!nodes) return ''
  return nodes
    .map((node) => {
      if (node.type === 'text') {
        return applyMarks(node.text ?? '', node.marks)
      }
      if (node.type === 'hardBreak') return '\n'
      if (node.type === 'image') {
        const alt = (node.attrs?.alt as string | null) ?? ''
        const src = (node.attrs?.src as string | null) ?? ''
        return `![${alt}](${src})`
      }
      return renderNode(node).trimEnd()
    })
    .join('')
}

// ─── Block-level nodes ────────────────────────────────────────────────────────

function renderNode(node: JSONContent): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map(renderNode).join('')

    case 'paragraph':
      return renderInline(node.content) + '\n\n'

    case 'heading': {
      const level = (node.attrs?.level as number) ?? 1
      const prefix = '#'.repeat(Math.min(Math.max(level, 1), 6))
      return `${prefix} ${renderInline(node.content)}\n\n`
    }

    case 'codeBlock': {
      const lang = (node.attrs?.language as string | null) ?? ''
      const code = (node.content ?? []).map((n) => n.text ?? '').join('')
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`
    }

    case 'blockquote': {
      const innerLines = (node.content ?? []).map((child) => {
        if (child.type === 'paragraph') return renderInline(child.content)
        return renderNode(child).trimEnd()
      })
      const lines = innerLines.map((l) => `> ${l}`).join('\n')
      return lines + '\n\n'
    }

    case 'bulletList': {
      const items = (node.content ?? []).map((item) => {
        const body = renderListItemContent(item)
        return `- ${body}`
      })
      return items.join('\n') + '\n\n'
    }

    case 'orderedList': {
      const start = (node.attrs?.start as number) ?? 1
      const items = (node.content ?? []).map((item, idx) => {
        const body = renderListItemContent(item)
        return `${start + idx}. ${body}`
      })
      return items.join('\n') + '\n\n'
    }

    case 'taskList': {
      const items = (node.content ?? []).map((item) => {
        const checked = (item.attrs?.checked as boolean) ?? false
        const body = renderListItemContent(item)
        return `- [${checked ? 'x' : ' '}] ${body}`
      })
      return items.join('\n') + '\n\n'
    }

    case 'listItem':
    case 'taskItem':
      return renderListItemContent(node)

    case 'horizontalRule':
      return '---\n\n'

    case 'hardBreak':
      return '\n'

    case 'image': {
      const alt = (node.attrs?.alt as string | null) ?? ''
      const src = (node.attrs?.src as string | null) ?? ''
      return `![${alt}](${src})\n\n`
    }

    case 'video': {
      const src = (node.attrs?.src as string | null) ?? ''
      return `[Video](${src})\n\n`
    }

    case 'audio': {
      const src = (node.attrs?.src as string | null) ?? ''
      return `[Audio](${src})\n\n`
    }

    case 'table':
      return renderTable(node)

    case 'tableRow':
    case 'tableCell':
    case 'tableHeader':
      // handled inside renderTable; should not be called standalone
      return ''

    default:
      return `<!-- unsupported: ${node.type ?? 'unknown'} -->\n\n`
  }
}

// ─── List item helper ─────────────────────────────────────────────────────────

function renderListItemContent(item: JSONContent): string {
  const parts = (item.content ?? []).map((child) => {
    if (child.type === 'paragraph') return renderInline(child.content)
    return renderNode(child).trimEnd()
  })
  return parts.join(' ')
}

// ─── Table ────────────────────────────────────────────────────────────────────

function renderTable(table: JSONContent): string {
  const rows = table.content ?? []
  if (rows.length === 0) return ''

  const rendered = rows.map((row) =>
    (row.content ?? []).map((cell) => renderInline(cell.content ?? [])).join(' | '),
  )

  const colCount = (rows[0].content ?? []).length
  const separator = Array(colCount).fill('---').join(' | ')

  const firstRow = rows[0]
  const hasHeader = (firstRow.content ?? []).some((c) => c.type === 'tableHeader')

  if (hasHeader) {
    const [header, ...body] = rendered
    const lines = [`| ${header} |`, `| ${separator} |`, ...body.map((r) => `| ${r} |`)]
    return lines.join('\n') + '\n\n'
  }

  // No header row: treat first data row as implicit header (GFM requires a separator).
  const [implicitHeader, ...rest] = rendered
  const lines = [`| ${implicitHeader} |`, `| ${separator} |`, ...rest.map((r) => `| ${r} |`)]
  return lines.join('\n') + '\n\n'
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a TipTap `JSONContent` document tree to a Markdown string.
 *
 * Handles: paragraph, heading (h1-h3), bold, italic, strike, code inline,
 * codeBlock, blockquote, bulletList, orderedList, taskList, table,
 * horizontalRule, hardBreak, link, image, video, audio.
 *
 * Unknown node types produce an HTML comment:
 *   `<!-- unsupported: <type> -->`
 */
export function exportMarkdown(content: JSONContent): string {
  return renderNode(content)
}
