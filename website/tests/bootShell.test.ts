import { expect, it } from 'vitest'
import {
  applyMarketingShell,
  injectBootShell,
  renderBootNoscript,
  renderBootSplash,
  renderBootStyle,
} from '../src/bootShell'
import { renderLandingStaticHtml } from '../src/prerender'

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>Memlore</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

const ROOT_OPEN = '<div id="root">'

it('hides #root until html.site-ready without display:none', () => {
  const css = renderBootStyle()
  expect(css).toContain('html:not(.site-ready)')
  expect(css).toMatch(/html:not\(\.site-ready\)[^{]*#root/)
  expect(css).toMatch(/clip(?:-path)?\s*:/)
  expect(css).not.toMatch(/#root[^}]*display\s*:\s*none/)
})

it('paints a branded splash outside #root with the Memlore wordmark and logo', () => {
  const splash = renderBootSplash()
  expect(splash).toContain('class="site-boot"')
  expect(splash).toContain('aria-hidden="true"')
  expect(splash).toContain('Memlore')
  expect(splash).toContain('./logo-without-container/256.png')

  const html = injectBootShell(SHELL)
  const splashAt = html.indexOf('class="site-boot"')
  const rootAt = html.indexOf(ROOT_OPEN)
  expect(splashAt).toBeGreaterThan(-1)
  expect(rootAt).toBeGreaterThan(splashAt)
  expect(html.slice(rootAt)).not.toContain('site-boot')
})

it('reveals #root and hides the splash when JavaScript is off', () => {
  const noscript = renderBootNoscript()
  expect(noscript).toContain('<noscript>')
  expect(noscript).toMatch(/#root/)
  expect(noscript).toMatch(/clip(?:-path)?\s*:\s*(?:auto|none)/)
  expect(noscript).toMatch(/\.site-boot[^}]*display\s*:\s*none/)
})

it('inlines the light and dark paper colors and kills motion when asked', () => {
  const css = renderBootStyle()
  expect(css).toContain('oklch(0.995 0.003 55)')
  expect(css).toContain('oklch(0.145 0.004 55)')
  expect(css).toContain('oklch(0.985 0.002 55)')
  expect(css).toContain('prefers-color-scheme: dark')
  expect(css).toContain('prefers-reduced-motion')
})

it('keeps the crawler twin in #root after the boot fragments are injected', () => {
  const article = renderLandingStaticHtml()
  const html = injectBootShell(SHELL).replace(
    '<div id="root"></div>',
    `${ROOT_OPEN}${article}</div>`,
  )
  expect(html).toContain('<main id="main">')
  expect(html).toContain('privacy.html')
  expect(html).toContain('class="site-boot"')
})

it('still bakes the landing article into #root and leaves the splash as a sibling', () => {
  const html = applyMarketingShell(SHELL, '/index.html', renderLandingStaticHtml())
  expect(html).toContain(`${ROOT_OPEN}<main id="main">`)
  expect(html).toContain('privacy.html')
  const rootInner = html.slice(
    html.indexOf(ROOT_OPEN),
    html.indexOf('</div>', html.indexOf(ROOT_OPEN)),
  )
  expect(rootInner).not.toContain('site-boot')
  expect(html.indexOf('class="site-boot"')).toBeLessThan(html.indexOf(ROOT_OPEN))
})

it('adds the splash to changelog.html without inventing a crawler twin', () => {
  const html = applyMarketingShell(SHELL, '/changelog.html')
  expect(html).toContain('class="site-boot"')
  expect(html).toContain('<div id="root"></div>')
})

it('does not inject the splash into demo.html', () => {
  expect(applyMarketingShell(SHELL, '/demo.html')).toBe(SHELL)
})
