import { expect, it } from 'vitest'
import { DIAGRAMS } from '../src/docs/diagrams'
import {
  isExternalHref,
  parseInline,
  parseLegalMarkdown,
  renderLegalStaticHtml,
} from '../src/legal/markdown'

const SAMPLE = `---
title: Memlore — Privacy Policy
description: A short description.
updated: 17 September 2026
---

# Privacy Policy

Intro paragraph with [contact@memlore.app](mailto:contact@memlore.app).

## A heading

First body.

Second body.

- One
- Two
`

it('reads title, description, and updated from frontmatter', () => {
  const doc = parseLegalMarkdown(SAMPLE)
  expect(doc.meta).toEqual({
    title: 'Memlore — Privacy Policy',
    description: 'A short description.',
    updated: '17 September 2026',
  })
})

it('parses headings, paragraphs, and lists', () => {
  const { blocks } = parseLegalMarkdown(SAMPLE)
  expect(blocks).toEqual([
    { type: 'h1', text: 'Privacy Policy' },
    { type: 'p', text: 'Intro paragraph with [contact@memlore.app](mailto:contact@memlore.app).' },
    { type: 'h2', text: 'A heading', id: 'a-heading' },
    { type: 'p', text: 'First body.' },
    { type: 'p', text: 'Second body.' },
    { type: 'ul', items: ['One', 'Two'] },
  ])
})

it('rejects markdown without frontmatter', () => {
  expect(() => parseLegalMarkdown('# Hi\n')).toThrow(/frontmatter/)
})

it('turns markdown links into inline anchors', () => {
  expect(parseInline('See [the policy](https://example.com) now.')).toEqual([
    { type: 'text', text: 'See ' },
    { type: 'a', text: 'the policy', href: 'https://example.com' },
    { type: 'text', text: ' now.' },
  ])
})

it('treats http(s) links as external and mailto as local', () => {
  expect(isExternalHref('https://developers.google.com/terms/api-services-user-data-policy')).toBe(
    true,
  )
  expect(isExternalHref('mailto:contact@memlore.app')).toBe(false)
})

it('renders static HTML for crawlers that do not execute JS', () => {
  const html = renderLegalStaticHtml(SAMPLE)
  expect(html).toContain('<article class="legal-article">')
  expect(html).toContain('<h1>Privacy Policy</h1>')
  expect(html).toContain('<h2 id="a-heading">A heading</h2>')
  expect(html).toContain('<p class="legal-updated">Last updated 17 September 2026</p>')
  expect(html).toContain('<li>One</li>')
  expect(html).toContain('<a href="mailto:contact@memlore.app">contact@memlore.app</a>')
})

it('escapes HTML-significant characters in text and hrefs', () => {
  const html = renderLegalStaticHtml(`---
title: T
description: D
updated: 1 January 2026
---

# Tom & Jerry <script>

Read the [terms & "rules"](https://x.test/?a=1&b=2).
`)
  expect(html).toContain('<h1>Tom &amp; Jerry &lt;script&gt;</h1>')
  expect(html).toContain('<a href="https://x.test/?a=1&amp;b=2" target="_blank" rel="noreferrer">')
  expect(html).toContain('terms &amp; &quot;rules&quot;')
  expect(html).not.toContain('<script>')
})

const META = `---
title: T
description: D
updated: 1 January 2026
---
`

it('parses a third-level heading with a stable id', () => {
  const source = `${META}\n### A subheading\n`
  const { blocks } = parseLegalMarkdown(source)
  expect(blocks).toContainEqual({ type: 'h3', text: 'A subheading', id: 'a-subheading' })
  expect(renderLegalStaticHtml(source)).toContain('<h3 id="a-subheading">A subheading</h3>')
})

it('parses an ordered list', () => {
  const source = `${META}\n1. First\n2. Second\n`
  const { blocks } = parseLegalMarkdown(source)
  expect(blocks).toContainEqual({ type: 'ol', items: ['First', 'Second'] })
  expect(renderLegalStaticHtml(source)).toContain('<ol><li>First</li><li>Second</li></ol>')
})

it('parses bold and a link in one line', () => {
  expect(parseInline('See **the policy** and [read it](https://example.com).')).toEqual([
    { type: 'text', text: 'See ' },
    { type: 'strong', text: 'the policy' },
    { type: 'text', text: ' and ' },
    { type: 'a', text: 'read it', href: 'https://example.com' },
    { type: 'text', text: '.' },
  ])
  expect(parseInline('[read it](https://example.com) and **the policy**')).toEqual([
    { type: 'a', text: 'read it', href: 'https://example.com' },
    { type: 'text', text: ' and ' },
    { type: 'strong', text: 'the policy' },
  ])
  const html = renderLegalStaticHtml(
    `${META}\nSee **the policy** and [read it](https://example.com).\n`,
  )
  expect(html).toContain('<strong>the policy</strong>')
  expect(html).toContain(
    '<a href="https://example.com" target="_blank" rel="noreferrer">read it</a>',
  )
})

it('escapes script tags in paragraph prose and bold', () => {
  const html = renderLegalStaticHtml(`${META}\nA <script>alert(1)</script> and **<script>**.\n`)
  expect(html).toContain('A &lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('<strong>&lt;script&gt;</strong>')
  expect(html).not.toContain('<script>')
})

it('parses a known diagram into the registry svg', () => {
  const source = `${META}\n:::diagram privacy\n`
  const { blocks } = parseLegalMarkdown(source)
  expect(blocks).toContainEqual({ type: 'diagram', name: 'privacy' })
  const html = renderLegalStaticHtml(source)
  expect(DIAGRAMS.privacy).toContain('role="img"')
  expect(html).toContain(DIAGRAMS.privacy)
  expect(html).not.toContain('<figure')
})

it('rejects an unknown diagram name at parse time', () => {
  expect(() => parseLegalMarkdown(`${META}\n:::diagram nope\n`)).toThrow(/unknown diagram/)
})

it('suffixes a repeated heading id', () => {
  const { blocks } = parseLegalMarkdown(`${META}\n## Same\n\n## Same\n`)
  expect(blocks).toEqual([
    { type: 'h2', text: 'Same', id: 'same' },
    { type: 'h2', text: 'Same', id: 'same-2' },
  ])
})
