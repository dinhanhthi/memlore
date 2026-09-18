import { expect, it } from 'vitest'
import { ROUTES, normalizePath } from '../src/router'
import indexHtml from '../index.html?raw'
import privacyHtml from '../privacy.html?raw'
import termsHtml from '../terms.html?raw'
import changelogHtml from '../changelog.html?raw'

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
  ] as const) {
    expect(normalizePath(path), path).toBe(expected)
  }
})

// `about` is absent on purpose — phase 2 adds about.html.
it('titles the same page the static shell does, so SPA navigation cannot drift from it', () => {
  for (const [name, html] of [
    ['home', indexHtml],
    ['privacy', privacyHtml],
    ['terms', termsHtml],
    ['changelog', changelogHtml],
  ] as const) {
    expect(html).toContain(`<title>${ROUTES[name].title}</title>`)
  }
})

it('keeps every route path extensionless and absolute', () => {
  for (const route of Object.values(ROUTES)) {
    expect(route.path).toMatch(/^\/[^.]*$/)
  }
})
