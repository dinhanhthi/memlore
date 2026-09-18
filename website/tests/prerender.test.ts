import { expect, it } from 'vitest'
import { prerenderCopy, renderLandingStaticHtml } from '../src/prerender'
import landingSource from '../src/LandingPage.tsx?raw'
import footerSource from '../src/SiteFooterBar.tsx?raw'
import websiteIndex from '../index.html?raw'

const html = renderLandingStaticHtml()

it('states what the app is, so a crawler that runs no JS can read it', () => {
  expect(html).toContain(`<h1>${prerenderCopy.heroTitleLead} ${prerenderCopy.heroTitleAccent}</h1>`)
  expect(html).toContain(prerenderCopy.heroDescriptionLead)
  expect(html).toContain(prerenderCopy.encryptBody)
})

it('explains why the app asks for cloud access', () => {
  expect(html).toContain(prerenderCopy.syncTitle)
  expect(html).toContain('Google Drive')
})

it('links the privacy policy and terms, as Google requires of a homepage', () => {
  expect(html).toContain(`<a href="privacy.html">${prerenderCopy.privacyLink}</a>`)
  expect(html).toContain(`<a href="terms.html">${prerenderCopy.termsLink}</a>`)
})

it('escapes HTML-significant characters from content strings', () => {
  expect(html).not.toMatch(/<(?!\/?(?:main|h1|h2|p|nav|a)\b)/)
})

// The prerendered copy is duplicated from the components on purpose. Prettier
// fill-wraps the long prose across source lines, so compare whitespace-collapsed.
const collapse = (text: string) => text.replace(/\s+/g, ' ')
// The meta description is the only prerendered string a component does not
// render — it ships in the `<meta>` tag — so it is checked against index.html
// alone. Everything else must match the components: index.html's `<title>`
// repeats the h1, and folding it in here would hide an h1 that drifted.
const { metaDescription, ...componentCopy } = prerenderCopy
const componentSource = collapse(`${landingSource}\n${footerSource}`)

it.each(Object.entries(componentCopy))(
  'keeps the prerendered %s in step with the copy the components render',
  (key, copy) => {
    expect(
      componentSource.includes(collapse(copy)),
      `prerender.ts copy "${key}" (${copy}) no longer appears in LandingPage.tsx or SiteFooterBar.tsx — the static crawler shell has drifted from the page`,
    ).toBe(true)
  },
)

it('keeps the prerendered metaDescription in step with the <meta> tag', () => {
  expect(
    collapse(websiteIndex).includes(collapse(metaDescription)),
    'prerender.ts copy "metaDescription" no longer appears in index.html — the static crawler shell has drifted from the page',
  ).toBe(true)
})
