import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderSimpleMarkdown } from './simpleMarkdown'

function html(input: string): string {
  return renderToStaticMarkup(renderSimpleMarkdown(input) as React.ReactElement)
}

describe('renderSimpleMarkdown', () => {
  it('renders a bullet list', () => {
    const out = html('- one\n- two\n- three')
    expect(out).toContain('<ul')
    expect(out).toMatch(/<li[^>]*>.*one.*<\/li>/)
    expect(out).toMatch(/<li[^>]*>.*two.*<\/li>/)
    expect(out).toMatch(/<li[^>]*>.*three.*<\/li>/)
  })

  it('renders numbered list as <li>', () => {
    const out = html('1. first\n2. second')
    expect(out).toMatch(/<li[^>]*>.*first.*<\/li>/)
    expect(out).toMatch(/<li[^>]*>.*second.*<\/li>/)
  })

  it('renders bold and italic', () => {
    const out = html('- a **bold** word and an *italic* one')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
  })

  it('renders __bold__ and _italic_ alternates', () => {
    const out = html('__strong__ then _emph_')
    expect(out).toContain('<strong>strong</strong>')
    expect(out).toContain('<em>emph</em>')
  })

  it('partial bold marker renders as literal text (streaming-safe)', () => {
    const out = html('partial **stream in progress')
    // Open ** with no closer must not break; we expect the asterisks
    // to appear as literal characters in the output.
    expect(out).toContain('**')
    expect(out).not.toContain('<strong')
  })

  it('separates blank-line-separated blocks', () => {
    const out = html('first paragraph\n\n- bullet')
    expect(out).toContain('<p')
    expect(out).toContain('<ul')
  })

  it('does NOT inject raw HTML from markdown source', () => {
    // Defence: even if the model returns a literal HTML tag, the
    // renderer treats it as text (React escapes it).
    const out = html('- <script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('handles empty input gracefully', () => {
    const out = html('')
    // No paragraphs / lists for empty input.
    expect(out).toBe('')
  })

  describe('[id=…] entry references', () => {
    function htmlWithRefs(input: string): string {
      return renderToStaticMarkup(
        renderSimpleMarkdown(input, {
          renderEntryRef: (id) => <b data-entry={id}>REF</b>,
        }) as React.ReactElement,
      )
    }

    it('renders a marker through renderEntryRef', () => {
      const out = htmlWithRefs('See [id=f611b234-2cb5-4e70-9155-0b5a352ceb50] for details.')
      expect(out).toContain('data-entry="f611b234-2cb5-4e70-9155-0b5a352ceb50"')
      // The raw id must not survive anywhere in the output — the whole
      // point is that the reader never sees a UUID.
      expect(out).not.toContain('[id=')
      expect(out).toContain('See ')
      expect(out).toContain(' for details.')
    })

    it('renders every marker when one line carries several', () => {
      const out = htmlWithRefs('Both [id=abc] and [id=def] mention it.')
      expect(out).toContain('data-entry="abc"')
      expect(out).toContain('data-entry="def"')
    })

    it('leaves the marker literal when no renderer is supplied', () => {
      // Every non-chat caller (entry highlights, go-deeper, summaries) gets
      // the old behaviour untouched.
      const out = html('See [id=abc] here.')
      expect(out).toContain('[id=abc]')
    })

    it('ignores bracketed text that is not an entry marker', () => {
      const out = htmlWithRefs('A [link](url) and [id = abc] and [ident=abc] stay put.')
      expect(out).not.toContain('data-entry')
      expect(out).toContain('[id = abc]')
      expect(out).toContain('[ident=abc]')
    })

    it('leaves an unterminated marker literal mid-stream', () => {
      // Streaming: the closing bracket has not arrived yet. Rendering a
      // badge for a half-read id would flash the wrong entry.
      const out = htmlWithRefs('Partial [id=abc')
      expect(out).not.toContain('data-entry')
      expect(out).toContain('[id=abc')
    })

    it('renders markers inside bullets and headings too', () => {
      expect(htmlWithRefs('- from [id=abc]')).toContain('data-entry="abc"')
      expect(htmlWithRefs('## About [id=abc]')).toContain('data-entry="abc"')
    })
  })
})
