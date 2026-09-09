import { describe, expect, it } from 'vitest'
import { markdownToHtml } from './markdownToHtml'

describe('markdownToHtml', () => {
  it('renders an ATX h1', () => {
    expect(markdownToHtml('# Hello')).toBe('<h1>Hello</h1>')
  })

  it('renders h2 and h3', () => {
    expect(markdownToHtml('## Two')).toBe('<h2>Two</h2>')
    expect(markdownToHtml('### Three')).toBe('<h3>Three</h3>')
  })

  it('renders a paragraph', () => {
    expect(markdownToHtml('Just a line')).toBe('<p>Just a line</p>')
  })

  it('joins consecutive non-blank lines into one paragraph', () => {
    expect(markdownToHtml('Line one\nLine two')).toBe('<p>Line one Line two</p>')
  })

  it('separates paragraphs on blank lines', () => {
    expect(markdownToHtml('First.\n\nSecond.')).toBe('<p>First.</p><p>Second.</p>')
  })

  it('renders an unordered list', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('accepts * and + as bullet markers', () => {
    expect(markdownToHtml('* one\n+ two')).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('renders an ordered list', () => {
    expect(markdownToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>')
  })

  it('renders bold and italic inside a paragraph', () => {
    expect(markdownToHtml('A **bold** and *italic* word.')).toBe(
      '<p>A <strong>bold</strong> and <em>italic</em> word.</p>',
    )
  })

  it('supports __bold__ and _italic_ markers', () => {
    expect(markdownToHtml('__b__ and _i_')).toBe('<p><strong>b</strong> and <em>i</em></p>')
  })

  it('escapes raw HTML in text content', () => {
    expect(markdownToHtml('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>')
  })

  it('escapes HTML inside list items and headings', () => {
    expect(markdownToHtml('# <script>')).toBe('<h1>&lt;script&gt;</h1>')
    expect(markdownToHtml('- <img src=x>')).toBe('<ul><li>&lt;img src=x&gt;</li></ul>')
  })

  it('mixes headings, paragraphs and lists into a sensible document', () => {
    const md = '# Title\n\nIntro paragraph.\n\n- one\n- two\n\nOutro.'
    expect(markdownToHtml(md)).toBe(
      '<h1>Title</h1><p>Intro paragraph.</p><ul><li>one</li><li>two</li></ul><p>Outro.</p>',
    )
  })

  it('returns an empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('')
    expect(markdownToHtml('   \n\n  ')).toBe('')
  })

  it('treats unclosed inline markers as plain text', () => {
    expect(markdownToHtml('half **bold')).toBe('<p>half **bold</p>')
  })

  it('escapes single and double quotes in text content', () => {
    expect(markdownToHtml(`it's "fine"`)).toBe('<p>it&#39;s &quot;fine&quot;</p>')
  })

  it('never emits raw HTML attributes from injected content', () => {
    expect(markdownToHtml('# <a href="javascript:alert(1)">x</a>')).toBe(
      '<h1>&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;</h1>',
    )
  })

  it('handles ***bold-italic*** without breaking layout', () => {
    // The current converter does not implement combined bold+italic.
    // It matches `**` first, leaving a stray `*`. This test locks in
    // that documented behavior so a later refactor surfaces the
    // change explicitly.
    expect(markdownToHtml('***triple***')).toBe('<p><strong>*triple</strong>*</p>')
  })
})
