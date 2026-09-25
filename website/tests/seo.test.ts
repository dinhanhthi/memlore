import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
import aboutHtml from '../about.html?raw'
import changelogHtml from '../changelog.html?raw'
import privacyHtml from '../privacy.html?raw'
import termsHtml from '../terms.html?raw'
import demoHtml from '../demo.html?raw'
import { DOCS_PAGES, docsPath, docsShellFile } from '../src/docs/manifest'
import {
  buildRobots,
  buildSitemap,
  canonicalPaths,
  canonicalUrl,
  siteOrigin,
  type IndexableEntry,
} from '../src/seo'

const SHELL_ENTRIES = [
  'index.html',
  'about.html',
  'changelog.html',
  'privacy.html',
  'terms.html',
] as const satisfies readonly IndexableEntry[]

const shells: Record<(typeof SHELL_ENTRIES)[number], string> = {
  'index.html': indexHtml,
  'about.html': aboutHtml,
  'changelog.html': changelogHtml,
  'privacy.html': privacyHtml,
  'terms.html': termsHtml,
}

const docsShellHtml = import.meta.glob<string>('../docs/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function indexableShell(entry: IndexableEntry): string | undefined {
  switch (entry) {
    case 'index.html':
    case 'about.html':
    case 'changelog.html':
    case 'privacy.html':
    case 'terms.html':
      return shells[entry]
    default:
      return docsShellHtml[`../${entry}`]
  }
}

const entries = Object.keys(canonicalPaths) as IndexableEntry[]

describe('canonical tags', () => {
  it.each(SHELL_ENTRIES)('%s declares its canonical URL and og:url', (entry) => {
    const url = canonicalUrl(entry)
    expect(shells[entry]).toContain(`<link rel="canonical" href="${url}" />`)
    expect(shells[entry]).toContain(`<meta property="og:url" content="${url}" />`)
  })

  it('every indexable shell declares its canonical URL and og:url', () => {
    for (const entry of entries) {
      const html = indexableShell(entry)
      expect(html, entry).toEqual(expect.any(String))
      const url = canonicalUrl(entry)
      expect(html, entry).toContain(`<link rel="canonical" href="${url}" />`)
      expect(html, entry).toContain(`<meta property="og:url" content="${url}" />`)
    }
  })

  it('maps every docs page onto its shell and lists that canonical once', () => {
    const paths = canonicalPaths as Record<string, string>
    const sitemap = buildSitemap()
    for (const page of DOCS_PAGES) {
      const file = docsShellFile(page.slug)
      const path = docsPath(page.slug)
      expect(paths[file], file).toBe(path)
      const loc = `${siteOrigin}${path}`
      expect(sitemap.split(`<loc>${loc}</loc>`), loc).toHaveLength(2)
    }
  })

  it('canonicals are absolute on the https apex host', () => {
    for (const entry of entries) {
      expect(canonicalUrl(entry).startsWith('https://memlore.app/')).toBe(true)
    }
  })

  // `http://`, `http://www.` and `https://www.` all 301 to the apex. A canonical
  // pointing at any of them would hand Search Console a redirect as the indexable
  // URL, which is the reason those hosts were reported in the first place.
  it('no shell points a canonical at a redirecting host', () => {
    for (const html of [...Object.values(shells), ...Object.values(docsShellHtml)]) {
      expect(html).not.toMatch(/rel="canonical"[^>]*(http:\/\/|www\.memlore\.app)/)
    }
  })

  it('leaves the noindex demo out of the canonical set', () => {
    expect(entries).not.toContain('demo.html')
    expect(demoHtml).toContain('<meta name="robots" content="noindex" />')
  })
})

describe('buildSitemap', () => {
  it('lists every indexable page exactly once', () => {
    const sitemap = buildSitemap()
    for (const entry of entries) {
      expect(sitemap.split(`<loc>${canonicalUrl(entry)}</loc>`)).toHaveLength(2)
    }
  })

  it('lists nothing else', () => {
    expect(buildSitemap().match(/<loc>/g)).toHaveLength(entries.length)
  })

  // The namespace attribute is legitimately `http://`, so assert on the <loc>
  // values rather than the whole document.
  it('never lists a .html duplicate or a redirecting host', () => {
    const locs = [...buildSitemap().matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])
    expect(locs.length).toBeGreaterThan(0)
    for (const loc of locs) {
      expect(loc).not.toContain('.html')
      expect(loc).not.toContain('www.memlore.app')
      expect(loc.startsWith('https://memlore.app/')).toBe(true)
    }
  })

  it('is a well-formed urlset', () => {
    const sitemap = buildSitemap()
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(sitemap.trimEnd().endsWith('</urlset>')).toBe(true)
  })
})

describe('buildRobots', () => {
  it('points at the sitemap on the canonical origin', () => {
    expect(buildRobots()).toContain(`Sitemap: ${siteOrigin}/sitemap.xml`)
  })

  // An empty `Disallow:` is the conventional allow-everything form and is fine;
  // what must never appear is a rule that blocks a path, which would stop the
  // crawler fetching demo.html and therefore reading its noindex.
  it('crawls everything, so the demo noindex stays readable', () => {
    const robots = buildRobots()
    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Allow: /')
    expect(robots).not.toMatch(/Disallow:\s*\S/)
  })
})
