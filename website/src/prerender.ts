import { encrypt, footer, githubUrl, hero, legal, meta, nav, sync } from './content'
import { escapeHtml } from './legal/markdown'

/**
 * Static twin of the landing page's headline copy, injected into index.html at
 * build time. Google's OAuth reviewer fetches raw HTML and runs no JS: on the
 * client-rendered shell it sees no app description and no privacy policy link,
 * both of which their homepage requirements demand. Every string here is copy
 * the React page renders too — never crawler-only text.
 */
export function renderLandingStaticHtml(): string {
  const section = (title: string, body: string) =>
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>`
  return [
    '<main id="main">',
    `<h1>${escapeHtml(`${hero.titleLead} ${hero.titleAccent}`)}</h1>`,
    `<p>${escapeHtml(`${hero.descriptionLead} ${hero.description}`)}</p>`,
    `<p>${escapeHtml(meta.description)}</p>`,
    section(encrypt.title, encrypt.body),
    section(sync.title, sync.body),
    `<nav aria-label="${escapeHtml(legal.linksAria)}">`,
    `<a href="index.html">${escapeHtml(nav.wordmark)}</a>`,
    `<a href="changelog.html">${escapeHtml(legal.changelogLink)}</a>`,
    `<a href="privacy.html">${escapeHtml(legal.privacyLink)}</a>`,
    `<a href="terms.html">${escapeHtml(legal.termsLink)}</a>`,
    `<a href="${escapeHtml(githubUrl)}">${escapeHtml(footer.github)}</a>`,
    '</nav>',
    '</main>',
  ].join('')
}
