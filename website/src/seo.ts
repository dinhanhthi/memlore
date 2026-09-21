/**
 * Canonical URL set for the marketing site, shared by the `<link rel="canonical">`
 * tags in the page shells, `sitemap.xml`, and `robots.txt`.
 *
 * GitHub Pages serves every page under two paths — `/privacy` and `/privacy.html`
 * both return 200 — and answers on four hosts, three of which 301 to the fourth.
 * Without a canonical the crawler treats each of those as a separate candidate.
 * The clean extensionless path is the canonical one because that is what the React
 * router produces and what the site's own nav links to; `.html` stays reachable
 * because Memlore's Google OAuth consent screen registers `privacy.html`.
 */
export const siteOrigin = 'https://memlore.app'

/** Built HTML entry → the canonical path it should declare. `demo.html` is noindex. */
export const canonicalPaths = {
  'index.html': '/',
  'about.html': '/about',
  'changelog.html': '/changelog',
  'privacy.html': '/privacy',
  'terms.html': '/terms',
} as const

export type IndexableEntry = keyof typeof canonicalPaths

export function canonicalUrl(entry: IndexableEntry): string {
  return `${siteOrigin}${canonicalPaths[entry]}`
}

export function buildSitemap(): string {
  const urls = (Object.keys(canonicalPaths) as IndexableEntry[])
    .map((entry) => `  <url><loc>${canonicalUrl(entry)}</loc></url>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

/**
 * `demo.html` is deliberately not disallowed: it carries `<meta name="robots"
 * content="noindex">`, and a crawler blocked from fetching it can never read that.
 */
export function buildRobots(): string {
  return `User-agent: *
Allow: /

Sitemap: ${siteOrigin}/sitemap.xml
`
}
