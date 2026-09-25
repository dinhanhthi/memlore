import { expect, it } from 'vitest'
import { DOCS_PAGES, docsRouteKey, docsShellFile } from '../src/docs/manifest'
import { ROUTES, normalizePath } from '../src/router'
import indexHtml from '../index.html?raw'
import privacyHtml from '../privacy.html?raw'
import termsHtml from '../terms.html?raw'
import changelogHtml from '../changelog.html?raw'
import aboutHtml from '../about.html?raw'

// The `.html` forms must keep resolving: https://memlore.app/privacy.html is the URL
// registered on Memlore's Google OAuth consent screen, and any link a user already
// bookmarked or a search engine already indexed still carries the extension.
it('resolves clean URLs, the legacy .html URLs Google OAuth has on file, and anything unknown', () => {
  for (const [path, expected] of [
    ['/', 'home'],
    ['', 'home'],
    ['/index.html', 'home'],
    ['/nope', 'home'],
    ['/privacy/extra', 'home'],
    ['/privacy', 'privacy'],
    ['/privacy.html', 'privacy'],
    ['/privacy/', 'privacy'],
    ['/terms', 'terms'],
    ['/terms.html', 'terms'],
    ['/changelog', 'changelog'],
    ['/changelog.html', 'changelog'],
    ['/about', 'about'],
    ['/about.html', 'about'],
    ['/docs', 'docs:overview'],
    ['/docs/', 'docs:overview'],
    ['/docs/index.html', 'docs:overview'],
    ['/docs/encryption', 'docs:encryption'],
    ['/docs/encryption.html', 'docs:encryption'],
    ['/docs/nope', 'home'],
  ] as const) {
    expect(normalizePath(path), path).toBe(expected)
  }
})

it('titles the same page the static shell does, so SPA navigation cannot drift from it', () => {
  for (const [name, html] of [
    ['home', indexHtml],
    ['privacy', privacyHtml],
    ['terms', termsHtml],
    ['changelog', changelogHtml],
    ['about', aboutHtml],
  ] as const) {
    expect(html).toContain(`<title>${ROUTES[name].title}</title>`)
  }
})

it('keeps every route path extensionless and absolute', () => {
  for (const route of Object.values(ROUTES)) {
    expect(route.path).toMatch(/^\/[^.]*$/)
  }
})

it('registers one docs route per manifest page', () => {
  for (const page of DOCS_PAGES) {
    const name = `docs:${page.slug}` as const
    expect(ROUTES[name].path, page.slug).toBe(docsRouteKey(page.slug))
    expect(ROUTES[name].title, page.slug).toBe(`Memlore — ${page.title}`)
    expect(normalizePath(docsRouteKey(page.slug)), page.slug).toBe(name)
    expect(normalizePath(`/${docsShellFile(page.slug)}`), page.slug).toBe(name)
  }
})
