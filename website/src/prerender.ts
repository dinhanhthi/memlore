import { escapeHtml } from './legal/markdown'
import { githubUrl } from './links'

/**
 * Static twin of the landing page's headline copy, injected into index.html at
 * build time. Google's OAuth reviewer fetches raw HTML and runs no JS: on the
 * client-rendered shell it sees no app description and no privacy policy link,
 * both of which their homepage requirements demand. Every string here is copy
 * the React page renders too — never crawler-only text. The strings below are
 * duplicated from the components on purpose — keep them in sync by hand.
 */
export const prerenderCopy = {
  heroTitleLead: 'A little life.',
  heroTitleAccent: 'A lasting story.',
  heroDescriptionLead: 'Memlore is a private journal.',
  heroDescription: 'For the days you want to remember, and the thoughts you need to put somewhere.',
  metaDescription:
    'A private place for your memories. Explore Memlore, an open-source journal for writing, reflecting, and finding your way back to what matters.',
  encryptTitle: 'No server. No backdoor. We cannot read it.',
  encryptBody:
    'Everything is encrypted on your device with your password — including what syncs to your own cloud. There is no Memlore server in between, and no way back in without that password.',
  syncTitle: 'Your cloud. Your account. Your key.',
  syncBody:
    'Entries are encrypted on your device, then synced through your own Google Drive or iCloud Drive. We never hold your files, your account, or your key.',
  linksAria: 'About, changelog, docs, privacy, terms, and GitHub',
  wordmark: 'Memlore',
  aboutLink: 'About',
  changelogLink: 'Changelog',
  docsLink: 'Docs',
  privacyLink: 'Privacy',
  termsLink: 'Terms',
  github: 'GitHub',
} as const

export function renderLandingStaticHtml(): string {
  const c = prerenderCopy
  const section = (title: string, body: string) =>
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>`
  return [
    '<main id="main">',
    `<h1>${escapeHtml(`${c.heroTitleLead} ${c.heroTitleAccent}`)}</h1>`,
    `<p>${escapeHtml(`${c.heroDescriptionLead} ${c.heroDescription}`)}</p>`,
    `<p>${escapeHtml(c.metaDescription)}</p>`,
    section(c.encryptTitle, c.encryptBody),
    section(c.syncTitle, c.syncBody),
    // These stay on their `.html` form on purpose: only crawlers and JS-off visitors
    // ever see this nav, and `https://memlore.app/privacy.html` is the exact URL
    // registered in Memlore's Google OAuth consent screen (docs/gdrive-oauth-setup.md).
    // React replaces this markup with the clean `/privacy` URLs on mount.
    `<nav aria-label="${escapeHtml(c.linksAria)}">`,
    `<a href="index.html">${escapeHtml(c.wordmark)}</a>`,
    `<a href="about.html">${escapeHtml(c.aboutLink)}</a>`,
    `<a href="changelog.html">${escapeHtml(c.changelogLink)}</a>`,
    `<a href="docs/index.html">${escapeHtml(c.docsLink)}</a>`,
    `<a href="privacy.html">${escapeHtml(c.privacyLink)}</a>`,
    `<a href="terms.html">${escapeHtml(c.termsLink)}</a>`,
    `<a href="${escapeHtml(githubUrl)}">${escapeHtml(c.github)}</a>`,
    '</nav>',
    '</main>',
  ].join('')
}
