import { DOCS_PAGES, docsPath, docsShellFile, type DocsSlug } from './docs/manifest'

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

type DocsCanonical = {
  [P in DocsSlug as P extends 'overview'
    ? 'docs/index.html'
    : `docs/${P}.html`]: P extends 'overview' ? '/docs/' : `/docs/${P}`
}

/** Built HTML entry → the canonical path it should declare. `demo.html` is noindex. */
export const canonicalPaths = {
  'index.html': '/',
  'about.html': '/about',
  'changelog.html': '/changelog',
  'privacy.html': '/privacy',
  'terms.html': '/terms',
  ...Object.fromEntries(DOCS_PAGES.map((page) => [docsShellFile(page.slug), docsPath(page.slug)])),
} as {
  'index.html': '/'
  'about.html': '/about'
  'changelog.html': '/changelog'
  'privacy.html': '/privacy'
  'terms.html': '/terms'
} & DocsCanonical

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

const SOCIAL_IMAGE_PATH = '/memlore-poster.png'
const SOCIAL_IMAGE_ALT =
  'Memlore, a private journal: "A little life. A lasting story." beside the app in its Signature, Clean and Clay themes, with a low-poly golden retriever mascot.'

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function headValue(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1]?.replace(/\s+/g, ' ').trim()
}

/**
 * Open Graph + Twitter card tags for a page shell, derived from the `<title>`,
 * `description` and `canonical` the shell already declares so the previews can't
 * drift from the page. Returns '' for shells with no canonical (`demo.html`, which
 * is noindex and not worth a share card). The strings are read back from HTML that
 * is already escaped, so they are re-emitted verbatim rather than escaped twice.
 */
export function renderSocialMeta(html: string): string {
  const url = headValue(html, /<link\s+rel="canonical"\s+href="([^"]+)"/)
  const title = headValue(html, /<title>([^<]*)<\/title>/)
  const description = headValue(html, /<meta\s+name="description"\s+content="([^"]*)"/)
  if (!url || !title || !description) return ''

  const image = `${siteOrigin}${SOCIAL_IMAGE_PATH}`
  const alt = escapeAttr(SOCIAL_IMAGE_ALT)
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Memlore" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="2400" />`,
    `<meta property="og:image:height" content="1260" />`,
    `<meta property="og:image:alt" content="${alt}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${alt}" />`,
  ]
  if (url === `${siteOrigin}/`) tags.push(renderLandingJsonLd(description))
  return tags.join('\n    ')
}

/** Structured data for Google: names the site and the app behind it. */
function renderLandingJsonLd(description: string): string {
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Memlore',
      url: `${siteOrigin}/`,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Memlore',
      applicationCategory: 'LifestyleApplication',
      operatingSystem: 'macOS',
      description: description.replaceAll('&amp;', '&'),
      url: `${siteOrigin}/`,
      image: `${siteOrigin}${SOCIAL_IMAGE_PATH}`,
      license: 'https://www.gnu.org/licenses/agpl-3.0.html',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ]
  // "<" can't appear in a JSON-LD string and close the script element early.
  const json = JSON.stringify(data).replaceAll('<', '\\u003c')
  return `<script type="application/ld+json">${json}</script>`
}
