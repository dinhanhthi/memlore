import { expect, it } from 'vitest'
import { encrypt, hero, legal, sync } from '../src/content'
import { renderLandingStaticHtml } from '../src/prerender'

const html = renderLandingStaticHtml()

it('states what the app is, so a crawler that runs no JS can read it', () => {
  expect(html).toContain(`<h1>${hero.titleLead} ${hero.titleAccent}</h1>`)
  expect(html).toContain(hero.descriptionLead)
  expect(html).toContain(encrypt.body)
})

it('explains why the app asks for cloud access', () => {
  expect(html).toContain(sync.title)
  expect(html).toContain('Google Drive')
})

it('links the privacy policy and terms, as Google requires of a homepage', () => {
  expect(html).toContain(`<a href="privacy.html">${legal.privacyLink}</a>`)
  expect(html).toContain(`<a href="terms.html">${legal.termsLink}</a>`)
})

it('escapes HTML-significant characters from content strings', () => {
  expect(html).not.toMatch(/<(?!\/?(?:main|h1|h2|p|nav|a)\b)/)
})
