import { expect, it } from 'vitest'
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
    { type: 'h2', text: 'A heading' },
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
  expect(html).toContain('<h2>A heading</h2>')
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
