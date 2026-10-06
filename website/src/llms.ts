import { releases, type ChangelogPlatform } from './changelog/changelogData'
import { DOCS_PAGES, docsPath } from './docs/manifest'
import { downloadUrl, githubUrl, webAppLive, webAppUrl } from './links'
import { prerenderCopy } from './prerender'
import { siteOrigin } from './seo'

export type LlmsLegalDescriptions = {
  about: string
  privacy: string
  terms: string
}

function latestStable(platform: ChangelogPlatform): { version: string; date: string } | undefined {
  const release = releases.find((item) => item.stable && (item.platform ?? 'mac') === platform)
  if (!release) return
  return { version: release.version, date: release.date }
}

function link(title: string, url: string, description: string): string {
  return `- [${title}](${url}): ${description}`
}

/**
 * Markdown index at `/llms.txt`. Descriptions come from the same sources as the
 * public pages, so a content edit refreshes this file on the next website build.
 * File IO stays in the Vite plugin — this module must not be imported by a page.
 */
export function buildLlmsTxt(legal: LlmsLegalDescriptions): string {
  const mac = latestStable('mac')
  const web = latestStable('web')
  const changelog = ['Plain-language release notes.']
  if (mac) changelog.push(`Latest Mac release is v${mac.version} (${mac.date}).`)
  if (web) changelog.push(`Latest web release is v${web.version} (${web.date}).`)

  const docs = DOCS_PAGES.map((page) =>
    link(page.title, `${siteOrigin}${docsPath(page.slug)}`, page.description),
  )

  const site = [
    link('Home', `${siteOrigin}/`, prerenderCopy.metaDescription),
    link('About', `${siteOrigin}/about`, legal.about),
    link('Changelog', `${siteOrigin}/changelog`, changelog.join(' ')),
    link('Privacy', `${siteOrigin}/privacy`, legal.privacy),
    link('Terms', `${siteOrigin}/terms`, legal.terms),
    link(
      'Download for Mac',
      downloadUrl,
      'Current Mac build. The download counter records time, version, and country, then redirects to the GitHub asset.',
    ),
    ...(webAppLive
      ? [
          link(
            'Web companion',
            webAppUrl,
            'In-browser journal that signs in with the recovery phrase.',
          ),
        ]
      : []),
    link('GitHub', githubUrl, 'Source, issues, and the AGPL-3.0 license.'),
  ]

  return [
    '# Memlore',
    '',
    `> ${prerenderCopy.metaDescription}`,
    '',
    `${prerenderCopy.heroDescriptionLead} ${prerenderCopy.heroDescription}`,
    '',
    prerenderCopy.encryptBody,
    '',
    prerenderCopy.syncBody,
    '',
    '## Docs',
    '',
    ...docs,
    '',
    '## Site',
    '',
    ...site,
    '',
    '## Optional',
    '',
    link('Live demo', `${siteOrigin}/#demo`, 'Interactive demo on the homepage.'),
    '',
  ].join('\n')
}
