import { expect, it } from 'vitest'
import * as content from '../src/content'
import { comparison, demo, features, githubUrl, meta, nav, platforms } from '../src/content'
import websiteIndex from '../index.html?raw'

const PRICE =
  /\$\s*\d|€\s*\d|£\s*\d|\d[\d,]*(?:\.\d+)?\s*(?:usd|eur|gbp|dollars?)|\b(?:usd|eur|gbp)\s*\d|\b\d+(?:\.\d+)?\s*\/\s*(?:mo|month|yr|year)\b/i
const SHIP_DATE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b|\b20\d{2}\b|\bq[1-4]\s*20\d{2}\b|\b(?:next|this)\s+(?:spring|summer|fall|autumn|winter|year|month)\b|\b(?:by|in|during)\s+(?:q[1-4]|january|february|march|april|june|july|august|september|october|november|december)\b/i
const DOWNLOAD_OR_RELEASE =
  /\bdownload(?:s|ing)?\b|\breleases?\b|\breleased\b|\bget the app\b|\bapp store\b|\bplay store\b|\bmicrosoft store\b/i
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

it('does not claim a download or production release', () => {
  expect(allCopy()).not.toMatch(DOWNLOAD_OR_RELEASE)
})

it('compares Memlore, Day One, Journey, and Apple Journal with a strength and a tradeoff each', () => {
  for (const name of ['Memlore', 'Day One', 'Journey', 'Apple Journal']) {
    const entry = product(name)
    expect(entry.strength.trim().length).toBeGreaterThan(20)
    expect(entry.tradeoff.trim().length).toBeGreaterThan(20)
  }
})

it('describes Apple Journal as more than an iPhone app', () => {
  const apple = `${product('Apple Journal').strength} ${product('Apple Journal').tradeoff}`
  expect(apple).toMatch(/iPad/i)
  expect(apple).toMatch(/Mac/i)
  expect(apple).not.toMatch(/iPhone[- ]only/i)
})

it('states Memlore’s tradeoff as beta and macOS today', () => {
  const tradeoff = product('Memlore').tradeoff
  expect(tradeoff).toMatch(/beta/i)
  expect(tradeoff).toMatch(/macOS/i)
})

it('does not claim competitors lack encryption or AI', () => {
  const competitorCopy = comparison.products
    .filter((item) => item.name !== 'Memlore')
    .flatMap((item) => [item.strength, item.tradeoff])
    .join('\n')
  expect(competitorCopy).not.toMatch(LACKS_ENCRYPTION_OR_AI)
})

it('treats Doc as a coming-soon disclosure, not a documentation URL', () => {
  expect(nav.docDisclosure).toMatch(/coming soon/i)
  expect(nav.docDisclosure).not.toMatch(/https?:\/\//i)
})

it('covers the required feature themes from real product capabilities', () => {
  const copy = collectStrings(features).join('\n').toLowerCase()
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
  expect(copy).toMatch(/own cloud|your own cloud/)
  expect(copy).toMatch(/sync/)
  expect(copy).toMatch(/import/)
  expect(copy).toMatch(/export/)
  expect(copy).toMatch(/appearance|design/)
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

it('names the current macOS beta without promising other platforms a date', () => {
  const macos = platforms.items.find((item) => item.name === 'macOS')
  expect(macos?.status).toMatch(/in development/i)
  expect(macos?.status).toMatch(/beta/i)
})
