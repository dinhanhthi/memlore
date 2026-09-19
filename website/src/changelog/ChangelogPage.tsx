import { useEffect } from 'react'
import { preloadHeadSprites } from '../HeadFollowLogo'
import { LedgerGap, LedgerRule, SectionIndex } from '../Ledger'
import { SiteFooterBar } from '../SiteFooterBar'
import { SiteHeader } from '../SiteHeader'
import { useActiveChangelogAnchor } from './activeChangelogAnchor'
import {
  releaseAnchorId,
  releases,
  type ChangelogKind,
  type ChangelogRelease,
} from './changelogData'

/** Date-only strings parse as UTC; formatting in UTC keeps the day from sliding. */
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

function formatDate(date: string): string {
  return DATE_FORMAT.format(new Date(`${date}T00:00:00Z`))
}

const kinds = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  breaking: 'Breaking',
} satisfies Record<ChangelogKind, string>

function Release({ release }: { release: ChangelogRelease }) {
  const id = releaseAnchorId(release.version)
  return (
    <section className="changelog-release">
      <div className="changelog-release-head">
        <h2 id={id}>v{release.version}</h2>
        {release.stable ? null : <span className="changelog-beta">Beta</span>}
        <p className="changelog-date">
          Released <time dateTime={release.date}>{formatDate(release.date)}</time>
        </p>
      </div>
      {release.stable ? null : (
        <p className="changelog-beta-note">
          A test version. Stable is what most people should run.
        </p>
      )}
      <ul className="changelog-items">
        {release.items.map((item) => (
          <li key={item.text}>
            <span className="changelog-kind" data-kind={item.kind}>
              {kinds[item.kind]}
            </span>
            <span className="changelog-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ChangelogToc() {
  const active = useActiveChangelogAnchor()
  return (
    <nav className="changelog-toc" aria-label="Release versions">
      <p className="changelog-toc-title">Versions</p>
      <ol>
        {releases.map((release) => {
          const id = releaseAnchorId(release.version)
          return (
            <li key={release.version}>
              <a href={`#${id}`} aria-current={active === id ? 'true' : undefined}>
                v{release.version}
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default function ChangelogPage() {
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader homeHref="/" sectionPrefix="/" current="changelog" />
      <main id="main" className="ledger" tabIndex={-1}>
        <div className="changelog-layout">
          <article className="changelog-article">
            <SectionIndex>Changelog</SectionIndex>
            <h1>What’s new</h1>
            <LedgerRule />
            <p className="changelog-intro">Every version of Memlore, in plain words.</p>
            <LedgerRule />
            <LedgerGap />
            {releases.map((release) => (
              <div key={release.version}>
                <LedgerRule />
                <Release release={release} />
              </div>
            ))}
          </article>
          <ChangelogToc />
        </div>
      </main>
      <footer>
        <LedgerRule />
        <SiteFooterBar homeHref="/" current="changelog" />
      </footer>
    </>
  )
}
