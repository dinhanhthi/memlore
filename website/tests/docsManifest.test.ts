import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_PAGES, docsPath, docsRouteKey, docsShellFile, neighbours } from '../src/docs/manifest'
import { parseLegalMarkdown } from '../src/legal/markdown'
import { siteOrigin } from '../src/seo'

const SLUGS = [
  'overview',
  'how-privacy-works',
  'encryption',
  'locks',
  'sync',
  'ai',
  'backup-and-recovery',
  'search-and-media',
  'memory',
  'persona',
  'customization',
  'maps',
  'editor',
] as const

const TITLES: Record<(typeof SLUGS)[number], string> = {
  overview: 'Overview',
  'how-privacy-works': 'How privacy works',
  encryption: 'Encryption',
  locks: 'Locks',
  sync: 'Sync',
  ai: 'AI',
  'backup-and-recovery': 'Backup and recovery',
  'search-and-media': 'Search and media',
  memory: 'Memory',
  persona: 'Persona',
  customization: 'Customization',
  maps: 'Maps',
  editor: 'Editor',
}

const PROTECTION = new Set<string>(['overview', 'how-privacy-works', 'encryption', 'locks'])

const DIAGRAMS: Partial<Record<(typeof SLUGS)[number], string>> = {
  'how-privacy-works': 'privacy',
  encryption: 'encryption',
  locks: 'locks',
  sync: 'sync',
  ai: 'ai',
}

describe('DOCS_PAGES', () => {
  it('lists thirteen unique slugs in reading order, with overview first', () => {
    const slugs = DOCS_PAGES.map((page) => page.slug)
    expect(slugs).toEqual([...SLUGS])
    expect(new Set(slugs).size).toBe(SLUGS.length)
    expect(slugs[0]).toBe('overview')
  })

  it('uses the placeholder titles and a one-sentence description', () => {
    for (const page of DOCS_PAGES) {
      expect(page.title, page.slug).toBe(TITLES[page.slug])
      expect(page.description.trim(), page.slug).toMatch(/^[^.]+[.]$/)
    }
  })

  it('groups the first four pages as protection and the rest as features', () => {
    for (const page of DOCS_PAGES) {
      expect(page.group, page.slug).toBe(PROTECTION.has(page.slug) ? 'protection' : 'features')
    }
  })

  it('attaches a diagram only on the five diagram pages', () => {
    for (const page of DOCS_PAGES) {
      expect(page.diagram, page.slug).toBe(DIAGRAMS[page.slug])
    }
  })
})

describe('docs paths', () => {
  it('builds an href, a slashless route key, and a shell file for every slug', () => {
    for (const page of DOCS_PAGES) {
      expect(docsPath(page.slug), page.slug).toMatch(/^\/docs\/[a-z-]*$/)
      if (page.slug === 'overview') {
        expect(docsPath(page.slug)).toBe('/docs/')
        expect(docsRouteKey(page.slug)).toBe('/docs')
        expect(docsShellFile(page.slug)).toBe('docs/index.html')
      } else {
        expect(docsPath(page.slug)).toBe(`/docs/${page.slug}`)
        expect(docsRouteKey(page.slug)).toBe(`/docs/${page.slug}`)
        expect(docsShellFile(page.slug)).toBe(`docs/${page.slug}.html`)
      }
    }
  })
})

describe('neighbours', () => {
  it('has no previous page on overview and no next page on editor', () => {
    const first = neighbours('overview')
    expect(first.prev).toBeUndefined()
    expect(first.next?.slug).toBe('how-privacy-works')

    const last = neighbours('editor')
    expect(last.prev?.slug).toBe('maps')
    expect(last.next).toBeUndefined()
  })

  it('steps through the reading order in both directions', () => {
    for (let i = 0; i < DOCS_PAGES.length; i++) {
      const page = DOCS_PAGES[i]
      if (!page) continue
      const { prev, next } = neighbours(page.slug)
      expect(prev?.slug).toBe(DOCS_PAGES[i - 1]?.slug)
      expect(next?.slug).toBe(DOCS_PAGES[i + 1]?.slug)
    }
  })
})

describe('docs shells and placeholders', () => {
  it('parses each page and declares that page canonical on its shell', () => {
    for (const page of DOCS_PAGES) {
      const source = readFileSync(resolve(__dirname, `../src/docs/content/${page.slug}.md`), 'utf8')
      const doc = parseLegalMarkdown(source)
      expect(doc.meta.title, page.slug).toBe(page.title)

      const html = readFileSync(resolve(__dirname, `../${docsShellFile(page.slug)}`), 'utf8')
      const url = `${siteOrigin}${docsPath(page.slug)}`
      expect(html, page.slug).toContain(`<link rel="canonical" href="${url}" />`)
      expect(html, page.slug).toContain(`<meta property="og:url" content="${url}" />`)
      expect(html, page.slug).toContain('href="../logo-without-container/256.png"')
      expect(html, page.slug).not.toContain('href="./logo-without-container/256.png"')
    }
  })
})
