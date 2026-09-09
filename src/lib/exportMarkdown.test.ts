import { describe, it, expect } from 'vitest'
import { exportMarkdown } from './exportMarkdown'
import type { JSONContent } from '@tiptap/core'

function doc(...nodes: JSONContent[]): JSONContent {
  return { type: 'doc', content: nodes }
}
function p(...content: JSONContent[]): JSONContent {
  return { type: 'paragraph', content }
}
function text(t: string, marks?: JSONContent['marks']): JSONContent {
  return marks ? { type: 'text', text: t, marks } : { type: 'text', text: t }
}

// ── paragraph ────────────────────────────────────────────────────────────────

describe('exportMarkdown — paragraph', () => {
  it('renders plain paragraph with double newline', () => {
    expect(exportMarkdown(doc(p(text('Hello world'))))).toBe('Hello world\n\n')
  })

  it('renders empty paragraph as blank line', () => {
    expect(exportMarkdown(doc(p()))).toBe('\n\n')
  })

  it('renders two paragraphs separated by blank line', () => {
    expect(exportMarkdown(doc(p(text('First')), p(text('Second'))))).toBe('First\n\nSecond\n\n')
  })
})

// ── headings ─────────────────────────────────────────────────────────────────

describe('exportMarkdown — headings', () => {
  it('renders h1', () => {
    const node: JSONContent = { type: 'heading', attrs: { level: 1 }, content: [text('Title')] }
    expect(exportMarkdown(doc(node))).toBe('# Title\n\n')
  })

  it('renders h2', () => {
    const node: JSONContent = { type: 'heading', attrs: { level: 2 }, content: [text('Sub')] }
    expect(exportMarkdown(doc(node))).toBe('## Sub\n\n')
  })

  it('renders h3', () => {
    const node: JSONContent = { type: 'heading', attrs: { level: 3 }, content: [text('Deep')] }
    expect(exportMarkdown(doc(node))).toBe('### Deep\n\n')
  })
})

// ── inline marks ─────────────────────────────────────────────────────────────

describe('exportMarkdown — inline marks', () => {
  it('bold', () => {
    expect(exportMarkdown(doc(p(text('hi', [{ type: 'bold' }]))))).toBe('**hi**\n\n')
  })

  it('italic', () => {
    expect(exportMarkdown(doc(p(text('hi', [{ type: 'italic' }]))))).toBe('*hi*\n\n')
  })

  it('strike', () => {
    expect(exportMarkdown(doc(p(text('hi', [{ type: 'strike' }]))))).toBe('~~hi~~\n\n')
  })

  it('code inline', () => {
    expect(exportMarkdown(doc(p(text('x', [{ type: 'code' }]))))).toBe('`x`\n\n')
  })

  it('link', () => {
    const mark = { type: 'link', attrs: { href: 'https://example.com', target: null } }
    expect(exportMarkdown(doc(p(text('click', [mark]))))).toBe('[click](https://example.com)\n\n')
  })

  it('bold + italic combined', () => {
    expect(exportMarkdown(doc(p(text('bi', [{ type: 'bold' }, { type: 'italic' }]))))).toBe(
      '***bi***\n\n',
    )
  })
})

// ── code block ───────────────────────────────────────────────────────────────

describe('exportMarkdown — codeBlock', () => {
  it('renders fenced code block with language', () => {
    const node: JSONContent = {
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [text('const x = 1')],
    }
    expect(exportMarkdown(doc(node))).toBe('```typescript\nconst x = 1\n```\n\n')
  })

  it('renders fenced code block without language', () => {
    const node: JSONContent = {
      type: 'codeBlock',
      attrs: {},
      content: [text('hello')],
    }
    expect(exportMarkdown(doc(node))).toBe('```\nhello\n```\n\n')
  })
})

// ── blockquote ────────────────────────────────────────────────────────────────

describe('exportMarkdown — blockquote', () => {
  it('renders blockquote with > prefix', () => {
    const node: JSONContent = {
      type: 'blockquote',
      content: [p(text('A quote'))],
    }
    expect(exportMarkdown(doc(node))).toBe('> A quote\n\n')
  })

  it('multi-line blockquote prefixes each line', () => {
    const node: JSONContent = {
      type: 'blockquote',
      content: [p(text('line one')), p(text('line two'))],
    }
    expect(exportMarkdown(doc(node))).toBe('> line one\n> line two\n\n')
  })
})

// ── bullet list ───────────────────────────────────────────────────────────────

describe('exportMarkdown — bulletList', () => {
  it('renders bullet list', () => {
    const node: JSONContent = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [p(text('Alpha'))] },
        { type: 'listItem', content: [p(text('Beta'))] },
      ],
    }
    expect(exportMarkdown(doc(node))).toBe('- Alpha\n- Beta\n\n')
  })
})

// ── ordered list ──────────────────────────────────────────────────────────────

describe('exportMarkdown — orderedList', () => {
  it('renders ordered list with sequential numbers', () => {
    const node: JSONContent = {
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        { type: 'listItem', content: [p(text('One'))] },
        { type: 'listItem', content: [p(text('Two'))] },
      ],
    }
    expect(exportMarkdown(doc(node))).toBe('1. One\n2. Two\n\n')
  })
})

// ── task list (checklist) ─────────────────────────────────────────────────────

describe('exportMarkdown — taskList / checklist', () => {
  it('renders checked and unchecked items', () => {
    const node: JSONContent = {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [p(text('todo'))] },
        { type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] },
      ],
    }
    expect(exportMarkdown(doc(node))).toBe('- [ ] todo\n- [x] done\n\n')
  })
})

// ── horizontal rule ───────────────────────────────────────────────────────────

describe('exportMarkdown — horizontalRule', () => {
  it('renders ---', () => {
    expect(exportMarkdown(doc({ type: 'horizontalRule' }))).toBe('---\n\n')
  })
})

// ── hardBreak ────────────────────────────────────────────────────────────────

describe('exportMarkdown — hardBreak', () => {
  it('renders hardBreak as newline inside paragraph', () => {
    const node = p(text('line one'), { type: 'hardBreak' }, text('line two'))
    expect(exportMarkdown(doc(node))).toBe('line one\nline two\n\n')
  })
})

// ── image ─────────────────────────────────────────────────────────────────────

describe('exportMarkdown — image', () => {
  it('renders image with alt and src', () => {
    const node: JSONContent = {
      type: 'image',
      attrs: { src: './media/abc.jpg', alt: 'Photo', 'data-media-id': 'abc' },
    }
    expect(exportMarkdown(doc(p(node)))).toBe('![Photo](./media/abc.jpg)\n\n')
  })

  it('renders image without alt using empty string', () => {
    const node: JSONContent = {
      type: 'image',
      attrs: { src: './media/xyz.png', alt: null },
    }
    expect(exportMarkdown(doc(p(node)))).toBe('![](./media/xyz.png)\n\n')
  })
})

// ── video ─────────────────────────────────────────────────────────────────────

describe('exportMarkdown — video', () => {
  it('renders video as link attachment', () => {
    const node: JSONContent = {
      type: 'video',
      attrs: { src: './media/clip.mp4', 'data-media-id': 'clip' },
    }
    expect(exportMarkdown(doc(node))).toBe('[Video](./media/clip.mp4)\n\n')
  })
})

// ── audio ─────────────────────────────────────────────────────────────────────

describe('exportMarkdown — audio', () => {
  it('renders audio as link attachment', () => {
    const node: JSONContent = {
      type: 'audio',
      attrs: { src: './media/memo.m4a', 'data-media-id': 'memo' },
    }
    expect(exportMarkdown(doc(node))).toBe('[Audio](./media/memo.m4a)\n\n')
  })
})

// ── table ─────────────────────────────────────────────────────────────────────

describe('exportMarkdown — table', () => {
  it('renders GFM table with header separator', () => {
    const node: JSONContent = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(text('Name'))] },
            { type: 'tableHeader', content: [p(text('Age'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(text('Alice'))] },
            { type: 'tableCell', content: [p(text('30'))] },
          ],
        },
      ],
    }
    expect(exportMarkdown(doc(node))).toBe('| Name | Age |\n| --- | --- |\n| Alice | 30 |\n\n')
  })

  it('renders headerless table with implicit header + separator', () => {
    const node: JSONContent = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(text('R1C1'))] },
            { type: 'tableCell', content: [p(text('R1C2'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(text('R2C1'))] },
            { type: 'tableCell', content: [p(text('R2C2'))] },
          ],
        },
      ],
    }
    expect(exportMarkdown(doc(node))).toBe('| R1C1 | R1C2 |\n| --- | --- |\n| R2C1 | R2C2 |\n\n')
  })
})

// ── unknown node type ─────────────────────────────────────────────────────────

describe('exportMarkdown — unsupported node', () => {
  it('emits HTML comment for unknown node types', () => {
    const node: JSONContent = { type: 'customWidget', attrs: { foo: 'bar' } }
    expect(exportMarkdown(doc(node))).toBe('<!-- unsupported: customWidget -->\n\n')
  })
})

// ── empty / null doc ──────────────────────────────────────────────────────────

describe('exportMarkdown — edge cases', () => {
  it('returns empty string for doc with no content', () => {
    expect(exportMarkdown({ type: 'doc', content: [] })).toBe('')
  })

  it('returns empty string for doc without content field', () => {
    expect(exportMarkdown({ type: 'doc' })).toBe('')
  })
})
