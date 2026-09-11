import { expect, it } from 'vitest'
import * as content from '../src/content'
import {
  ai,
  comparison,
  demo,
  editor,
  encrypt,
  githubUrl,
  hero,
  locations,
  locks,
  meta,
  nav,
  persona,
  platforms,
  search,
  transfer,
} from '../src/content'
import websiteIndex from '../index.html?raw'

const PRICE =
  /\$\s*\d|€\s*\d|£\s*\d|\d[\d,]*(?:\.\d+)?\s*(?:usd|eur|gbp|dollars?)|\b(?:usd|eur|gbp)\s*\d|\b\d+(?:\.\d+)?\s*\/\s*(?:mo|month|yr|year)\b/i
const SHIP_DATE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b|\b20\d{2}\b|\bq[1-4]\s*20\d{2}\b|\b(?:next|this)\s+(?:spring|summer|fall|autumn|winter|year|month)\b|\b(?:by|in|during)\s+(?:q[1-4]|january|february|march|april|june|july|august|september|october|november|december)\b/i
const STORE_RELEASE = /\bapp store\b|\bplay store\b|\bmicrosoft store\b|\bproduction release\b/i
const LACKS_ENCRYPTION_OR_AI =
  /\b(?:no|without|lack(?:s|ing)?|doesn't have|does not have)\s+(?:end-to-end\s+)?(?:encryption|ai)\b|\b(?:encryption|ai)\s+(?:not available|unavailable)\b/i

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

function allCopy(): string {
  return collectStrings(content).join('\n')
}

function product(name: string) {
  const entry = comparison.products.find((item) => item.name === name)
  expect(entry, `${name} must appear in the comparison`).toBeTruthy()
  return entry!
}

it('uses the exact public GitHub URL', () => {
  expect(githubUrl).toBe('https://github.com/dinhanhthi/memlore')
})

it('says features are free during beta and that external AI providers may charge', () => {
  const copy = allCopy().toLowerCase()
  expect(copy).toMatch(/free during beta/)
  expect(copy).toMatch(/third-party|external/)
  expect(copy).toMatch(/may charge|their own fees/)
  expect(copy).not.toMatch(/free forever|always free|free for life/)
})

it('does not include concrete currency or price strings', () => {
  expect(allCopy()).not.toMatch(PRICE)
})

it('does not promise ship dates for Windows, Linux, iOS, or Android', () => {
  const comingSoon = platforms.items.filter((item) => /coming soon/i.test(item.status))
  const names = comingSoon.map((item) => item.name).join(' ')
  expect(names).toMatch(/Windows/i)
  expect(names).toMatch(/Linux/i)
  expect(names).toMatch(/iOS/i)
  expect(names).toMatch(/Android/i)
  for (const item of comingSoon) {
    expect(item.status).toMatch(/^coming soon$/i)
    expect(item.status).not.toMatch(SHIP_DATE)
  }
  expect(allCopy()).not.toMatch(SHIP_DATE)
})

it('points the macOS beta download at GitHub, not a store', () => {
  expect(hero.download).toMatch(/download/i)
  expect(hero.download).toMatch(/beta/i)
  expect(nav.downloadAria).toMatch(/github/i)
  expect(allCopy()).not.toMatch(STORE_RELEASE)
})

it('compares Memlore, Day One, Journey, and Apple Journal in columns', () => {
  for (const name of ['Memlore', 'Day One', 'Journey', 'Apple Journal'] as const) {
    const entry = product(name)
    expect(entry.note.trim().length).toBeGreaterThan(20)
    for (const row of comparison.rows) {
      expect(row.marks[name]).toMatch(/^(yes|no|partial)$/)
    }
  }
  expect(comparison.rows.length).toBeGreaterThan(5)
})

it('does not put an Open source badge on the Memlore comparison column', () => {
  expect('badge' in product('Memlore')).toBe(false)
})

it('describes Apple Journal as more than an iPhone app', () => {
  const apple = product('Apple Journal').note
  expect(apple).toMatch(/iPad/i)
  expect(apple).toMatch(/Mac/i)
  expect(apple).not.toMatch(/iPhone[- ]only/i)
})

it('states Memlore’s note as beta and macOS today', () => {
  const note = product('Memlore').note
  expect(note).toMatch(/beta/i)
  expect(note).toMatch(/macOS/i)
})

it('does not claim competitors lack encryption or AI', () => {
  const competitorCopy = comparison.products
    .filter((item) => item.name !== 'Memlore')
    .map((item) => item.note)
    .join('\n')
  expect(competitorCopy).not.toMatch(LACKS_ENCRYPTION_OR_AI)
  expect(comparison.rows.find((row) => /optional ai/i.test(row.label))?.marks['Day One']).toBe(
    'yes',
  )
  expect(comparison.rows.find((row) => /optional ai/i.test(row.label))?.marks.Journey).toBe('yes')
})

it('treats Doc as a coming-soon disclosure, not a documentation URL', () => {
  expect(nav.docDisclosure).toMatch(/coming soon/i)
  expect(nav.docDisclosure).not.toMatch(/https?:\/\//i)
})

it('uses a still mascot description when the head does not follow the pointer', () => {
  expect(hero.mascotAltStill.toLowerCase()).toMatch(/mascot/)
  expect(hero.mascotAltStill.toLowerCase()).not.toMatch(/cursor/)
})

it('describes the compact demo as a placeholder until mobile apps exist', () => {
  expect(demo.placeholderTitle.toLowerCase()).toMatch(/wider window|larger screen/)
  expect(demo.placeholderBody.toLowerCase()).toMatch(/desktop/)
  expect(demo.placeholderBody.toLowerCase()).toMatch(/ios and android/)
  expect(demo).not.toHaveProperty('mobileHintBefore')
  expect(nav.menu).toMatch(/menu/i)
  expect(nav.closeMenu).toMatch(/close/i)
})

it('explains encryption for a non-technical reader', () => {
  const copy = collectStrings(encrypt).join('\n').toLowerCase()
  expect(copy).toMatch(/cannot read|never see/)
  expect(copy).toMatch(/password/)
  expect(copy).toMatch(/no server/)
  expect(copy).not.toMatch(/argon2|aes-256|sqlcipher|ciphertext|zeroize/)
})

it('names the editor and lists slash commands, GFM, and later plugins', () => {
  expect(editor.title.toLowerCase()).toMatch(/editor/)
  expect(editor.panes.map((pane) => pane.id)).toEqual(
    expect.arrayContaining(['slash', 'markdown', 'plugins']),
  )
  const copy = collectStrings(editor).join('\n').toLowerCase()
  expect(copy).toMatch(/slash/)
  expect(copy).toMatch(/github flavored markdown|\bgfm\b/)
  expect(copy).toMatch(/plugin/)
})

it('covers the required feature themes from real product capabilities', () => {
  const copy = [
    ...collectStrings(hero),
    ...collectStrings(encrypt),
    ...collectStrings(locks),
    ...collectStrings(ai),
    ...collectStrings(editor),
    ...collectStrings(search),
    ...collectStrings(persona),
    ...collectStrings(locations),
    ...collectStrings(transfer),
    ...collectStrings(comparison),
  ]
    .join('\n')
    .toLowerCase()
  expect(copy).toMatch(/writ|words|editor/)
  expect(copy).toMatch(/photo|media/)
  expect(copy).toMatch(/search/)
  expect(copy).toMatch(/tag/)
  expect(copy).toMatch(/calendar/)
  expect(copy).toMatch(/memor/)
  expect(copy).toMatch(/optional/)
  expect(copy).toMatch(/\bai\b/)
  expect(copy).toMatch(/local/)
  expect(copy).toMatch(/second lock|invisible/)
  expect(copy).toMatch(/own cloud|your own cloud|cloud folder/)
  expect(copy).toMatch(/sync/)
  expect(copy).toMatch(/persona/)
  expect(copy).toMatch(/rhythm/)
  expect(copy).toMatch(/map/)
  expect(copy).toMatch(/import/)
  expect(copy).toMatch(/export/)
  expect(copy).toMatch(/day one/)
  expect(copy).toMatch(/journey/)
  expect(copy).toMatch(/apple journal/)
})

it('tells visitors the demo window is clickable like the real app', () => {
  expect(demo.cue.toLowerCase()).toMatch(/click/)
  expect(demo.cue.toLowerCase()).toMatch(/real app/)
})

it('does not keep the landing tour or reset chrome', () => {
  expect(demo).not.toHaveProperty('tour')
  expect(demo).not.toHaveProperty('reset')
  expect(demo.openSeparately.toLowerCase()).toMatch(/open separately/)
})

it('scopes the design-system picker to the demo, not the landing chrome', () => {
  expect(demo.themeAria.toLowerCase()).toMatch(/choose appearance/)
  expect(demo.themeAria.toLowerCase()).not.toMatch(/website/)
})

it('does not stamp a live design-system attribute on the landing html', () => {
  expect(websiteIndex).not.toMatch(/data-design-system/)
})

it('keeps demo limitations visible for sample data and simulated AI, locks, and sync', () => {
  const disclaimer = demo.disclaimer.toLowerCase()
  expect(disclaimer).toMatch(/sample/)
  expect(disclaimer).toMatch(/simulat/)
  expect(disclaimer).toMatch(/\bai\b/)
  expect(disclaimer).toMatch(/lock/)
  expect(disclaimer).toMatch(/sync/)
})

it('cites only the recorded official comparison URLs', () => {
  expect(product('Day One').sourceUrl).toBe(
    'https://dayoneapp.com/guides/premium-subscription/day-one-pricing-features-guide/',
  )
  expect(product('Journey').sourceUrl).toBe(
    'https://support.journey.cloud/en/categories/purchase-payment/articles/journey-license-comparison',
  )
  expect(product('Apple Journal').sourceUrl).toBe(
    'https://apps.apple.com/us/app/journal/id6447391597?platform=ipad',
  )
})

it('keeps the HTML title and description in sync with the copy source', () => {
  expect(websiteIndex).toContain(`<title>${meta.title}</title>`)
  expect(websiteIndex).toContain(`content="${meta.description}"`)
})

it('ships a favicon from the existing logo assets', () => {
  expect(websiteIndex).toContain('rel="icon"')
  expect(websiteIndex).toContain('./logo-without-container/256.png')
})

it('names the current macOS beta without promising other platforms a date', () => {
  const macos = platforms.items.find((item) => item.name === 'macOS')
  expect(macos?.status).toMatch(/in development/i)
  expect(macos?.status).toMatch(/beta/i)
})
