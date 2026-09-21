import { expect, test } from '@playwright/test'
import { buildRobots, buildSitemap, canonicalPaths, canonicalUrl } from '../src/seo'

/**
 * `seo.test.ts` covers `buildRobots()` / `buildSitemap()` as pure functions, which
 * says nothing about whether they reach the deployed site. `robots.txt` and
 * `sitemap.xml` are emitted by the `emitSeoFiles` Vite plugin rather than copied
 * from `publicDir`, so unwiring that plugin would leave the unit tests green while
 * both files silently vanish from `dist`. This suite runs against the production
 * preview and closes that gap.
 */

test('robots.txt is served from the build with the sitemap pointer', async ({ request }) => {
  const response = await request.get('/robots.txt')
  expect(response.status()).toBe(200)
  expect(await response.text()).toBe(buildRobots())
})

test('sitemap.xml is served from the build with every canonical URL', async ({ request }) => {
  const response = await request.get('/sitemap.xml')
  expect(response.status()).toBe(200)
  expect(await response.text()).toBe(buildSitemap())
})

test('every indexable page serves its canonical tag', async ({ request }) => {
  for (const entry of Object.keys(canonicalPaths) as (keyof typeof canonicalPaths)[]) {
    const response = await request.get(`/${entry}`)
    expect(response.status(), `${entry} should be served`).toBe(200)
    expect(await response.text()).toContain(
      `<link rel="canonical" href="${canonicalUrl(entry)}" />`,
    )
  }
})
