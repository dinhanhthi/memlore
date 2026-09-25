import { expect, it } from 'vitest'
import * as ts from 'typescript'
import landingSource from '../src/LandingPage.tsx?raw'
import headerSource from '../src/SiteHeader.tsx?raw'
import footerSource from '../src/SiteFooterBar.tsx?raw'
import changelogPageSource from '../src/changelog/ChangelogPage.tsx?raw'
import legalPageSource from '../src/legal/LegalPage.tsx?raw'
import websiteIndex from '../index.html?raw'
import changelogHtml from '../changelog.html?raw'
import privacyHtml from '../privacy.html?raw'
import termsHtml from '../terms.html?raw'
import aboutMarkdown from '../src/legal/about.md?raw'
import privacyMarkdown from '../src/legal/privacy.md?raw'
import termsMarkdown from '../src/legal/terms.md?raw'
import { parseLegalMarkdown } from '../src/legal/markdown'
import { prerenderCopy } from '../src/prerender'
import { aiFeatureRequestUrl, editorFeatureRequestUrl, githubUrl, licenseUrl } from '../src/links'

/**
 * Every site string lives in the component that renders it, so this file reads
 * the component sources rather than a copy module. Literals repeated here are
 * pinned to the source with `toContain`, the same drift guard `prerender.test.ts`
 * uses: if the copy moves, the pin fails before the policy regex does.
 */

const contactEmail = 'contact@memlore.app'

const GOOGLE_USER_DATA_POLICY_URL =
  'https://developers.google.com/terms/api-services-user-data-policy'

const PRICE =
  /\$\s*\d|€\s*\d|£\s*\d|\d[\d,]*(?:\.\d+)?\s*(?:usd|eur|gbp|dollars?)|\b(?:usd|eur|gbp)\s*\d|\b\d+(?:\.\d+)?\s*\/\s*(?:mo|month|yr|year)\b/i
const SHIP_DATE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b|\b20\d{2}\b|\bq[1-4]\s*20\d{2}\b|\b(?:next|this)\s+(?:spring|summer|fall|autumn|winter|year|month)\b|\b(?:by|in|during)\s+(?:q[1-4]|january|february|march|april|june|july|august|september|october|november|december)\b/i
const STORE_RELEASE = /\bapp store\b|\bplay store\b|\bmicrosoft store\b|\bproduction release\b/i
const LACKS_ENCRYPTION_OR_AI =
  /\b(?:no|without|lack(?:s|ing)?|doesn't have|does not have)\s+(?:end-to-end\s+)?(?:encryption|ai)\b|\b(?:encryption|ai)\s+(?:not available|unavailable)\b/i

/** Prettier wraps JSX prose over several lines; flatten so a sentence matches whole. */
function flatten(source: string): string {
  return source.replace(/\s+/g, ' ')
}

const landing = flatten(landingSource)
const header = flatten(headerSource)

// The About page renders through the legal markdown parser. Use its blocks, not
// the raw file: the frontmatter carries an `updated: 20xx-xx-xx` date that the
// SHIP_DATE guard would read as a promised ship date.
const aboutText = parseLegalMarkdown(aboutMarkdown)
  .blocks.flatMap((block) => {
    if (block.type === 'ul' || block.type === 'ol') return block.items
    if (block.type === 'diagram') return []
    return [block.text]
  })
  .join('\n')

function allCopy(): string {
  return flatten(
    [
      landingSource,
      headerSource,
      footerSource,
      changelogPageSource,
      legalPageSource,
      aboutText,
      // The shells carry the <title> and <meta name="description"> — the only
      // strings a JS-off reader (Google's OAuth reviewer) ever sees.
      websiteIndex,
      changelogHtml,
    ].join('\n'),
  )
}

const COPY_ATTRIBUTES = new Set(['alt', 'aria-label', 'ariaLabel', 'label', 'title', 'placeholder'])

/**
 * The strings a visitor can actually read: JSX text plus copy-bearing literals,
 * with identifiers, class names and import paths left out. A positive match
 * against raw TSX would let `SearchFigure` stand in for the word "search" and
 * `className="ai-grid"` stand in for the AI copy.
 */
function readableCopy(source: string): string {
  const file = ts.createSourceFile(
    'copy.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) out.push(node.text)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent
      const isModulePath = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
      const isMachineAttribute =
        ts.isJsxAttribute(parent) && !COPY_ATTRIBUTES.has(parent.name.getText(file))
      if (!isModulePath && !isMachineAttribute) out.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return flatten(out.join('\n'))
}

function sourceBlock(start: string, end: string): string {
  const from = landingSource.indexOf(start)
  expect(from, `LandingPage.tsx must contain ${start}`).toBeGreaterThanOrEqual(0)
  const to = landingSource.indexOf(end, from)
  expect(to, `${end} must close ${start}`).toBeGreaterThan(from)
  return landingSource.slice(from, to)
}

const comparisonProductsSource = sourceBlock(
  'const comparisonProducts = [',
  '] satisfies ComparisonProduct[]',
)
const comparisonRowsSource = sourceBlock('const comparisonRows = [', '] satisfies ComparisonRow[]')
const platformItemsSource = sourceBlock('const platformItems = [', '] satisfies {')
const editorPanesSource = sourceBlock('const editorPanes = [', 'function EditorFigure')
const emotionOptionsSource = sourceBlock('const emotionOptions = [', '\n]')
const demoSource = sourceBlock('function DemoPlaceholder()', 'const aiItems = [')

type ComparisonProductName = 'Memlore' | 'Day One' | 'Journey' | 'Apple Journal'

const PRODUCT_NAMES = ['Memlore', 'Day One', 'Journey', 'Apple Journal'] as const

const COMPARISON_NOTES: Record<ComparisonProductName, string> = {
  Memlore:
    'Still in beta, and macOS-only today. Other platforms are coming, without a date attached.',
  'Day One':
    'A polished journaling home with a long-established ecosystem. Some features need a paid plan. The app is closed source.',
  Journey:
    'A journal across mobile, desktop, and the web. Desktop access and many features depend on a paid plan. The app is closed source.',
  'Apple Journal':
    'A simple journal for iPhone, iPad, and Mac, kept close to the rest of Apple’s world.',
}

function productNote(name: ComparisonProductName): string {
  const note = COMPARISON_NOTES[name]
  expect(
    flatten(comparisonProductsSource),
    `${name} must appear in the comparison with this note`,
  ).toContain(`name: '${name}', note: '${note}',`)
  return note
}

/** `{ 'open-source': { Memlore: 'yes', … }, … }`, read out of the rendered table data. */
function parseComparisonMarks(): Record<string, Record<string, string>> {
  const rows: Record<string, Record<string, string>> = {}
  for (const row of comparisonRowsSource.matchAll(
    /id: '([a-z0-9-]+)',[\s\S]*?marks: \{([^}]*)\}/g,
  )) {
    const marks: Record<string, string> = {}
    for (const pair of row[2].matchAll(/(?:'([^']+)'|(\w+)): (?:'([a-z]+)'|(\d+))/g)) {
      marks[pair[1] ?? pair[2]] = pair[3] ?? pair[4]
    }
    rows[row[1]] = marks
  }
  // A row whose id this regex cannot read must fail loudly, not shrink the check.
  expect(Object.keys(rows).length, 'every comparison row must be parsed, none skipped').toBe(
    comparisonRowsSource.match(/\bid: '/g)?.length ?? 0,
  )
  return rows
}

const comparisonMarks = parseComparisonMarks()

type PlatformName = 'macOS' | 'Windows & Linux' | 'iOS & Android'

const PLATFORM_ITEMS: { name: PlatformName; status: string }[] = [
  { name: 'macOS', status: 'Download' },
  { name: 'Windows & Linux', status: 'Coming soon' },
  { name: 'iOS & Android', status: 'Coming soon' },
]

function platformItems(): { name: PlatformName; status: string }[] {
  const flat = flatten(platformItemsSource)
  for (const item of PLATFORM_ITEMS) {
    expect(flat, `${item.name} must carry this status in the source`).toContain(
      `name: '${item.name}' as const, status: '${item.status}'`,
    )
  }
  expect(
    [...platformItemsSource.matchAll(/name: '[^']+' as const/g)],
    'no undeclared platform row may sneak in',
  ).toHaveLength(PLATFORM_ITEMS.length)
  return PLATFORM_ITEMS
}

const DEMO = {
  placeholderTitle: 'This preview needs a wider window.',
  placeholderBody:
    'The live journal is a desktop app, so it cannot run here. When the iOS and Android apps arrive, their view will take this place.',
  cue: 'Click around. It works like the real app.',
  themeAria: 'Choose appearance',
  posterAlt: 'Blurred preview of the Memlore journal with a sample entry open',
  start: 'Start the demo',
  openSeparately: 'Open separately',
  disclaimer: 'Sample data. Writing, locks, sync, and AI are simulated.',
} as const

const demoText = flatten(demoSource)
// Copy guards read this, not the raw slice: the slice holds identifiers
// (`changeTheme`, a future `reset` handler) that no visitor ever reads.
const demoReadable = readableCopy(demoSource)

function demoCopy(key: keyof typeof DEMO): string {
  const value = DEMO[key]
  expect(demoText, `the demo must still render its ${key} copy`).toContain(value)
  return value
}

const OPEN_SOURCE_BODY =
  'Open so you can see how a journal is secured and how your data is kept. Memlore stays free. Beta is only for extras that keep the project going.'
const HERO_DOWNLOAD = 'Download for Mac'
const DOWNLOAD_ARIA = 'Download the beta from GitHub'
const MASCOT_ALT_STILL = 'Memlore’s dog mascot.'
const NAV_MENU = 'Open menu'
const NAV_CLOSE_MENU = 'Close menu'
const EDITOR_TITLE = 'Feature-rich editor'
const EDITOR_BODY =
  'The Editor fully supports Markdown, math, code, media, @-mentions, and optional plugins. It responds quickly, even with very long content.'

it('uses the exact public GitHub URL', () => {
  expect(githubUrl).toBe('https://github.com/dinhanhthi/memlore')
})

it('points editor feature requests at a prefilled GitHub issue', () => {
  expect(editorFeatureRequestUrl).toBe(
    'https://github.com/dinhanhthi/memlore/issues/new?title=Editor%20feature%20request%3A%20&labels=enhancement',
  )
  expect(landing).toContain('editorFeatureRequestUrl')
  expect(landing).toContain('Need more?')
})

it('points AI feature requests at a prefilled GitHub issue', () => {
  expect(aiFeatureRequestUrl).toBe(
    'https://github.com/dinhanhthi/memlore/issues/new?title=AI%20feature%20request%3A%20&labels=enhancement',
  )
  expect(landing).toContain('aiFeatureRequestUrl')
  expect(landing).toContain('More to come')
})

it('points the spec-strip license at the AGPL file on GitHub', () => {
  expect(licenseUrl).toBe(`${githubUrl}?tab=AGPL-3.0-1-ov-file`)
  expect(landing).toContain('AGPLv3')
  expect(landing).toContain('licenseUrl')
  expect(landing).toContain('Read the source')
  expect(landing).toContain('<dt>version</dt>')
  expect(landing).toContain('<dt>size</dt>')
  expect(landing).toContain('180 MB')
  expect(landing).toContain('After install')
})

it('puts empty ledger rows above and below Made in the open', () => {
  expect(landing).toMatch(
    /<LedgerRule \/> <LedgerGap \/> <LedgerRule \/> <section className="open-section"/,
  )
  expect(landing).toMatch(
    /id="open-source">[\s\S]*?<\/section> <LedgerRule \/> <LedgerGap \/> <LedgerRule \/> <section className="compare-section"/,
  )
})

it('uses yellow group labels only for Demo, Features, AI, and Platforms', () => {
  const labels = [...landingSource.matchAll(/<SectionIndex>([^<]+)<\/SectionIndex>/g)].map(
    (match) => match[1],
  )
  expect(labels).toEqual(['Demo', 'Features', 'AI', 'Platforms'])
})

it('builds the hero eyebrow from the latest stable release without an Open source link', () => {
  expect(landing).toContain('hero-eyebrow')
  expect(landing).toContain('latestStableRelease')
  expect(landing).toContain('hero-eyebrow-version')
  expect(landing).toContain('Open source')
  expect(landing).not.toMatch(/<a href=\{githubUrl\}[^>]*>\s*Open source/)
  expect(landing).toContain('hero-eyebrow-free')
  expect(landing).toContain('hero-lead')
})

it('lays legal and changelog pages on the homepage ledger with a pinned footer', () => {
  expect(legalPageSource).toContain('className="ledger"')
  expect(legalPageSource).toContain('SectionIndex')
  expect(legalPageSource).toContain('LedgerRule')
  expect(legalPageSource).toMatch(/<footer>[\s\S]*LedgerRule/)
  expect(changelogPageSource).toContain('className="ledger"')
  expect(changelogPageSource).toContain('SectionIndex')
  expect(changelogPageSource).toContain('LedgerRule')
  expect(changelogPageSource).toMatch(/<footer>[\s\S]*LedgerRule/)
})

it('credits the author on the About page', () => {
  expect(aboutMarkdown).toContain('dinhanhthi.com')
  expect(aboutMarkdown).toContain('made with')
})

it('says the journal stays free and is open for security and data', () => {
  expect(landing).toContain(OPEN_SOURCE_BODY)
  const body = OPEN_SOURCE_BODY.toLowerCase()
  expect(body).toMatch(/stays free/)
  expect(body).toMatch(/secur/)
  expect(body).toMatch(/data/)
  expect(body).toMatch(/beta/)
  expect(landing).not.toMatch(/not a promise they stay free/)
})

it('does not include concrete currency or price strings', () => {
  expect(allCopy()).not.toMatch(PRICE)
})

it('does not promise ship dates for Windows, Linux, iOS, or Android', () => {
  const comingSoon = platformItems().filter((item) => /coming soon/i.test(item.status))
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

it('points the download at GitHub, not a store', () => {
  expect(landing).toContain(`label="${HERO_DOWNLOAD}"`)
  expect(HERO_DOWNLOAD).toMatch(/download/i)
  // Deliberately no /beta/i assertion on the button label. It was dropped from
  // the copy in f617a60, and v0.1.0 ships as a real signed, notarized release
  // rather than a beta — so calling the primary download a beta would now be
  // wrong. What still matters is that it goes to GitHub and never implies an
  // app store.
  expect(header).toContain(`ariaLabel="${DOWNLOAD_ARIA}"`)
  expect(DOWNLOAD_ARIA).toMatch(/github/i)
  expect(allCopy()).not.toMatch(STORE_RELEASE)
})

it('does not pin marketing copy to a single platform', () => {
  expect(allCopy()).not.toMatch(/\byour Mac\b|\bthis Mac\b|for your Mac/i)
})

it('splits phone and desktop apps into their own comparison rows', () => {
  expect(comparisonMarks.ios).toEqual({
    Memlore: 'soon',
    'Day One': 'yes',
    Journey: 'yes',
    'Apple Journal': 'yes',
  })
  expect(comparisonMarks.android).toEqual({
    Memlore: 'soon',
    'Day One': 'yes',
    Journey: 'yes',
    'Apple Journal': 'no',
  })
  expect(comparisonMarks.windows).toEqual({
    Memlore: 'soon',
    'Day One': 'yes',
    Journey: 'yes',
    'Apple Journal': 'no',
  })
  expect(comparisonMarks.linux).toEqual({
    Memlore: 'soon',
    'Day One': 'no',
    Journey: 'yes',
    'Apple Journal': 'no',
  })
  expect(comparisonRowsSource).not.toMatch(/iOS and Android app|Windows or Linux app/)
})

it('draws second lock and the invisible vault as separate blocks', () => {
  const figure = sourceBlock('function LocksFigure()', 'const editorPanes')
  const second = figure.indexOf('data-lock="second"')
  const invisible = figure.indexOf('data-lock="invisible"')
  expect(second).toBeGreaterThan(0)
  expect(invisible).toBeGreaterThan(figure.indexOf('</article>', second))
})

it('introduces plugins as optional and not shipped yet', () => {
  expect(landing).toContain('Plugins, only when you want them.')
  expect(landing).toContain('Extra tools arrive as plugins.')
  expect(landing).not.toContain('The journal stays')
  expect(landing).toContain('Coming soon')
  expect(landing).toContain('Install only what you need.')
  expect(landing).toContain('<dt>plugins</dt>')
  expect(landing).not.toContain('<dt>today</dt>')
  expect(landing).toContain('id="plugins"')
})

it('compares Memlore, Day One, Journey, and Apple Journal in columns', () => {
  const rowIds = Object.keys(comparisonMarks)
  expect(rowIds.length).toBeGreaterThan(5)
  for (const name of PRODUCT_NAMES) {
    expect(productNote(name).trim().length).toBeGreaterThan(20)
    for (const id of rowIds) {
      const mark = comparisonMarks[id][name]
      expect(mark, `${id} must score ${name}`).toBeDefined()
      if (/^\d+$/.test(mark)) expect(Number(mark)).toBeGreaterThanOrEqual(1)
      else expect(mark).toMatch(/^(yes|no|partial|soon)$/)
    }
  }
})

it('does not put an Open source badge on the Memlore comparison column', () => {
  expect(comparisonProductsSource).not.toMatch(/badge/i)
})

it('describes Apple Journal as more than an iPhone app', () => {
  const apple = productNote('Apple Journal')
  expect(apple).toMatch(/iPad/i)
  expect(apple).toMatch(/Mac/i)
  expect(apple).not.toMatch(/iPhone[- ]only/i)
})

it('states Memlore’s note as beta and macOS today', () => {
  const note = productNote('Memlore')
  expect(note).toMatch(/beta/i)
  expect(note).toMatch(/macOS/i)
})

it('does not claim competitors lack encryption or AI', () => {
  const competitorCopy = PRODUCT_NAMES.filter((name) => name !== 'Memlore')
    .map((name) => productNote(name))
    .join('\n')
  expect(competitorCopy).not.toMatch(LACKS_ENCRYPTION_OR_AI)
  const aiRow = comparisonMarks['optional-ai']
  expect(Number(aiRow['Day One'])).toBeGreaterThan(0)
  expect(Number(aiRow.Journey)).toBeGreaterThan(0)
})

it('scores Day One and Journey optional AI as levels, Apple Journal as none of that suite', () => {
  const aiRow = comparisonMarks['optional-ai']
  expect(aiRow.Memlore).toMatch(/^\d+$/)
  expect(aiRow['Day One']).toMatch(/^\d+$/)
  expect(aiRow.Journey).toMatch(/^\d+$/)
  expect(aiRow['Apple Journal']).toBe('no')
  expect(Number(aiRow['Day One'])).toBeGreaterThan(Number(aiRow.Journey))
  expect(Number(aiRow.Memlore)).toBeGreaterThan(Number(aiRow['Day One']))
})

it('links the header Docs item to /docs/', () => {
  expect(header).toContain('href="/docs/"')
})

it('uses a still mascot description when the head does not follow the pointer', () => {
  expect(landing).toContain(`alt="${MASCOT_ALT_STILL}"`)
  expect(MASCOT_ALT_STILL.toLowerCase()).toMatch(/mascot/)
  expect(MASCOT_ALT_STILL.toLowerCase()).not.toMatch(/cursor/)
})

it('describes the compact demo as a placeholder until mobile apps exist', () => {
  expect(demoCopy('placeholderTitle').toLowerCase()).toMatch(/wider window|larger screen/)
  expect(demoCopy('placeholderBody').toLowerCase()).toMatch(/desktop/)
  expect(demoCopy('placeholderBody').toLowerCase()).toMatch(/ios and android/)
  expect(demoSource).not.toMatch(/mobileHintBefore/)
  expect(header).toContain(`'${NAV_CLOSE_MENU}' : '${NAV_MENU}'`)
  expect(NAV_MENU).toMatch(/menu/i)
  expect(NAV_CLOSE_MENU).toMatch(/close/i)
})

it('explains encryption for a non-technical reader', () => {
  const lines = [
    prerenderCopy.encryptTitle,
    prerenderCopy.encryptBody,
    'Your content',
    'Your cloud',
    'Others (even us)',
    'Your password',
    'No access',
    'Encrypted before it leaves your device',
  ]
  for (const line of lines) expect(landing).toContain(line)
  const copy = lines.join('\n').toLowerCase()
  expect(copy).toMatch(/cannot read|never see/)
  expect(copy).toMatch(/password/)
  expect(copy).toMatch(/no server/)
  expect(copy).not.toMatch(/argon2|aes-256|sqlcipher|ciphertext|zeroize/)
})

it('names the editor and lists slash, mentions, markdown, and more plugins', () => {
  expect(landing).toContain(EDITOR_TITLE)
  expect(landing).toContain(EDITOR_BODY)
  expect(EDITOR_TITLE.toLowerCase()).toMatch(/editor/)
  const paneIds = [...editorPanesSource.matchAll(/id: '(\w+)' as const/g)].map((match) => match[1])
  expect(paneIds).toEqual(expect.arrayContaining(['slash', 'mention', 'markdown', 'plugins']))
  expect(EDITOR_BODY.toLowerCase()).toMatch(/mention/)
  const copy = [EDITOR_TITLE, EDITOR_BODY, editorPanesSource].join('\n').toLowerCase()
  expect(copy).toMatch(/slash command/)
  expect(copy).toMatch(/markdown/)
  expect(copy).toMatch(/more plugins/)
  expect(copy).toMatch(/need more/)
  expect(editorPanesSource).not.toMatch(/tag: 'GFM'/)
})

it('covers the required feature themes from real product capabilities', () => {
  const copy = flatten(
    [...[landingSource, headerSource, footerSource].map(readableCopy), aboutText].join('\n'),
  ).toLowerCase()
  expect(copy).toMatch(/writ|words|editor/)
  expect(copy).toMatch(/photo|media/)
  expect(copy).toMatch(/search/)
  expect(copy).toMatch(/calendar/)
  expect(copy).toMatch(/memor/)
  expect(copy).toMatch(/optional/)
  expect(copy).toMatch(/\bai\b/)
  expect(copy).toMatch(/local/)
  expect(copy).toMatch(/second lock|invisible/)
  expect(copy).toMatch(/own cloud|your own cloud|cloud folder/)
  expect(copy).toMatch(/sync/)
  expect(copy).toMatch(/persona/)
  expect(copy).toMatch(/build a second you/)
  expect(copy).toMatch(/voice/)
  expect(copy).toMatch(/opt in/)
  expect(copy).toMatch(/map/)
  expect(copy).toMatch(/import/)
  expect(copy).toMatch(/export/)
  expect(copy).toMatch(/day one/)
  expect(copy).toMatch(/journey/)
  expect(copy).toMatch(/apple journal/)
})

it('tells visitors the demo window is clickable like the real app', () => {
  expect(demoCopy('cue').toLowerCase()).toMatch(/click/)
  expect(demoCopy('cue').toLowerCase()).toMatch(/real app/)
})

it('does not keep the landing tour or reset chrome', () => {
  expect(demoReadable).not.toMatch(/\btour\b/i)
  expect(demoReadable).not.toMatch(/\breset\b/i)
  expect(demoCopy('openSeparately').toLowerCase()).toMatch(/open separately/)
})

it('gates the demo behind an explicit start with a labelled poster', () => {
  // Playwright matches this exact button name; keep them in sync.
  expect(demoCopy('start')).toBe('Start the demo')
  expect(demoCopy('posterAlt').toLowerCase()).toMatch(/preview/)
  expect(demoCopy('posterAlt').toLowerCase()).toMatch(/journal/)
})

it('scopes the design-system picker to the demo, not the landing chrome', () => {
  expect(demoCopy('themeAria').toLowerCase()).toMatch(/choose appearance/)
  expect(demoCopy('themeAria').toLowerCase()).not.toMatch(/website/)
})

it('does not stamp a live design-system attribute on the landing html', () => {
  expect(websiteIndex).not.toMatch(/data-design-system/)
})

it('keeps demo limitations visible for sample data and simulated AI, locks, and sync', () => {
  const disclaimer = demoCopy('disclaimer').toLowerCase()
  expect(disclaimer).toMatch(/sample/)
  expect(disclaimer).toMatch(/simulat/)
  expect(disclaimer).toMatch(/\bai\b/)
  expect(disclaimer).toMatch(/lock/)
  expect(disclaimer).toMatch(/sync/)
})

it('cites only the recorded official comparison URLs', () => {
  const urls = [...flatten(comparisonProductsSource).matchAll(/sourceUrl: '([^']+)'/g)].map(
    (match) => match[1],
  )
  expect(urls).toEqual([
    'https://dayoneapp.com/guides/premium-subscription/day-one-pricing-features-guide/',
    'https://support.journey.cloud/en/categories/purchase-payment/articles/journey-license-comparison',
    'https://apps.apple.com/us/app/journal/id6447391597?platform=ipad',
  ])
})

it('keeps the HTML title and description in sync with the copy source', () => {
  expect(websiteIndex).toContain(
    `<title>Memlore — ${prerenderCopy.heroTitleLead} ${prerenderCopy.heroTitleAccent}</title>`,
  )
  expect(websiteIndex).toContain(`content="${prerenderCopy.metaDescription}"`)
})

it('ships a favicon from the existing logo assets', () => {
  expect(websiteIndex).toContain('rel="icon"')
  expect(websiteIndex).toContain('./logo-without-container/256.png')
})

it('offers macOS a download without promising other platforms a date', () => {
  const macos = platformItems().find((item) => item.name === 'macOS')
  expect(macos?.status).toMatch(/download/i)
  // The platform link goes through the counting Worker, same as every other
  // Download button — not straight at the GitHub repo.
  expect(flatten(platformItemsSource)).toContain(
    `name: 'macOS' as const, status: '${macos?.status}', href: downloadUrl`,
  )
})

it('explains sync as the user’s own cloud, encrypted before it leaves the device', () => {
  // Prose only — `syncProviders` holds the ids 'gdrive'/'icloud', which would
  // satisfy these matches without the copy ever naming the services.
  const lines = [
    prerenderCopy.syncTitle,
    prerenderCopy.syncBody,
    'This device',
    'Your other devices',
    'Encrypted with your password',
    'Synced',
    'Your own cloud',
    'No Memlore server in between',
  ]
  for (const line of lines) expect(landing).toContain(line)
  const copy = lines.join('\n').toLowerCase()
  expect(copy).toMatch(/google drive/)
  expect(copy).toMatch(/icloud/)
  expect(copy).toMatch(/encrypt/)
  expect(copy).toMatch(/no memlore server|no server/)
  // A new device joins with the recovery phrase, not the password — the body
  // must not imply otherwise, so it stays off unlock mechanics entirely.
  expect(prerenderCopy.syncBody).not.toMatch(/password/i)
  expect(landingSource).toContain("const syncProviders = ['gdrive', 'icloud', 'more'] as const")
})

it('keeps emotions at exactly bad, neutral, and good', () => {
  const keys = [...emotionOptionsSource.matchAll(/key: '(\w+)' as const/g)].map((match) => match[1])
  expect(keys).toEqual(['bad', 'neutral', 'good'])
  expect(landingSource).not.toContain('emotionMarks')
  expect(landingSource).not.toContain('Emotion trend')
  // The figure marks the selected option inline rather than through a const.
  expect(landingSource).toContain("option.key === 'good'")
  expect(keys).toContain('good')
})

it('names the privacy policy and keeps a non-empty description', () => {
  const privacy = parseLegalMarkdown(privacyMarkdown)
  expect(privacy.blocks[0]).toEqual({ type: 'h1', text: 'Privacy Policy' })
  expect(privacy.meta.title.trim().length).toBeGreaterThan(0)
  expect(privacy.meta.description.trim().length).toBeGreaterThan(0)
})

it('names Google Drive and the drive.appdata scope in the privacy copy', () => {
  expect(privacyMarkdown).toMatch(/Google Drive/)
  expect(privacyMarkdown).toMatch(/drive\.appdata/)
})

it('keeps every Google Drive disclosure under a single heading', () => {
  const headings = [...privacyMarkdown.matchAll(/^## .+$/gm)].map((match) => match[0])
  const googleHeadings = headings.filter((heading) => /google/i.test(heading))
  expect(googleHeadings).toEqual(['## Optional Google Drive sync'])
})

it('describes optional iCloud Drive sync with the same honesty as Drive', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/icloud drive/)
  expect(copy).toMatch(/finder/)
  expect(copy).toMatch(/does not store an apple password|does not store.*icloud token/)
  expect(copy).toMatch(/disconnecting does not delete/)
})

it('includes the Google Limited Use sentence and the official policy URL', () => {
  expect(privacyMarkdown).toContain(
    "Memlore's use and transfer to any other app of information received from Google APIs",
  )
  expect(privacyMarkdown).toContain('Limited Use requirements')
  expect(privacyMarkdown).toContain(
    `[Google API Services User Data Policy](${GOOGLE_USER_DATA_POLICY_URL})`,
  )
})

it('says how long Google user data is kept and how to delete it', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/until you disconnect/)
  expect(copy).toMatch(/deleted from the local database/)
  expect(copy).toMatch(/disconnecting in the app does not delete/)
  expect(copy).toMatch(/manage apps/)
})

it('states every Limited Use prohibited purpose for Google user data', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/train generalized or non-personalized ai or ml models/)
  expect(copy).toMatch(/data brokers/)
  expect(copy).toMatch(/targeted, personalized, or interest-based ads/)
  expect(copy).toMatch(/credit-worthiness, lending/)
  expect(copy).toMatch(/no human at memlore reads your google user data/)
})

it('says the privacy policy includes no Memlore server and no telemetry', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/no memlore server/)
  expect(copy).toMatch(/no telemetry|no analytics/)
})

it('discloses what the download redirect records, and what it does not', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/dl\.memlore\.app/)
  expect(copy).toMatch(/no ip address is stored/)
  expect(copy).toMatch(/no cookie is set/)
})

it('keeps the privacy policy free of markdown the legal renderer cannot render', () => {
  // parseInline in src/legal/markdown.ts only understands [text](href); a
  // backtick or an asterisk would be painted literally on the public page.
  expect(privacyMarkdown).not.toMatch(/`/)
})

it('says AI in the privacy policy is optional and opt-in', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/\bai\b/)
  expect(copy).toMatch(/optional/)
  expect(copy).toMatch(/opt in|opt-in/)
})

it('does not mix Google API language into the AI section', () => {
  const ai = privacyMarkdown.split(/^## Optional AI\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  expect(ai.length).toBeGreaterThan(0)
  expect(ai).not.toMatch(/google/i)
})

it('does not claim an age limit the app does not enforce', () => {
  expect(privacyMarkdown).not.toMatch(/under 13|children/i)
})

it('lists the shipped contact email on the privacy, terms, and about pages', () => {
  expect(contactEmail).toBe('contact@memlore.app')
  expect(privacyMarkdown).toContain(contactEmail)
  expect(termsMarkdown).toContain(contactEmail)
  expect(aboutMarkdown).toContain(contactEmail)
})

it('says the Google account email stays on the device', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).toMatch(/google account email|email of (the |your )?google account/)
  expect(copy).toMatch(/on (your|the) device|\blocal\b/)
})

it('does not claim Google sees only encrypted data, and names the plaintext sync list', () => {
  const copy = privacyMarkdown.toLowerCase()
  expect(copy).not.toMatch(/only encrypted data|sees only encrypted/)
  expect(copy).toMatch(/sync (list|manifest)|\bjson\b/)
  expect(copy).toMatch(/not journal text|not (your )?journal/)
})

it('names AGPL in the terms copy', () => {
  expect(termsMarkdown).toMatch(/AGPL/)
})

it('says the terms cover a beta still in development', () => {
  const copy = termsMarkdown.toLowerCase()
  expect(copy).toMatch(/beta/)
  expect(copy).toMatch(/in development/)
})

it('says the software is provided as is, without warranty', () => {
  const copy = termsMarkdown.toLowerCase()
  expect(copy).toMatch(/as is/)
  expect(copy).toMatch(/no warranty|without warranty/)
})

it('says the user owns their journal in the terms copy', () => {
  const copy = termsMarkdown.toLowerCase()
  expect(copy).toMatch(/belongs to you|you own/)
  expect(copy).toMatch(/journal|data/)
})

it('keeps HTML title and description fields for both legal pages', () => {
  const privacy = parseLegalMarkdown(privacyMarkdown)
  const terms = parseLegalMarkdown(termsMarkdown)
  expect(privacy.meta.title.trim().length).toBeGreaterThan(0)
  expect(privacy.meta.description.trim().length).toBeGreaterThan(0)
  expect(terms.meta.title.trim().length).toBeGreaterThan(0)
  expect(terms.meta.description.trim().length).toBeGreaterThan(0)
})

it('keeps the legal HTML titles and descriptions in sync with the copy source', () => {
  const privacy = parseLegalMarkdown(privacyMarkdown)
  const terms = parseLegalMarkdown(termsMarkdown)
  expect(privacyHtml).toContain(`<title>${privacy.meta.title}</title>`)
  expect(privacyHtml).toContain(`content="${privacy.meta.description}"`)
  expect(termsHtml).toContain(`<title>${terms.meta.title}</title>`)
  expect(termsHtml).toContain(`content="${terms.meta.description}"`)
})
