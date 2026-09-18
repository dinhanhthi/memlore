import { useEffect } from 'react'
import { preloadHeadSprites } from '../HeadFollowLogo'
import { SiteFooterBar } from '../SiteFooterBar'
import { SiteHeader } from '../SiteHeader'
import {
  releaseAnchorId,
  releases,
  shouldShowChangelogToc,
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
  return (
    <nav className="changelog-toc" aria-label="Release versions">
      <p className="changelog-toc-title">Versions</p>
      <ol>
        {releases.map((release) => {
          const id = releaseAnchorId(release.version)
          return (
            <li key={release.version}>
              <a href={`#${id}`}>v{release.version}</a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default function ChangelogPage() {
  const showToc = shouldShowChangelogToc(releases.length)
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader homeHref="/" sectionPrefix="/" current="changelog" />
      <main id="main" tabIndex={-1}>
        <div className="changelog-layout" data-toc={showToc ? 'true' : undefined}>
          <article className="changelog-article">
            <h1>What’s new</h1>
            <p className="changelog-intro">Every version of Memlore, in plain words.</p>
            {releases.map((release) => (
              <Release key={release.version} release={release} />
            ))}
          </article>
          {showToc ? <ChangelogToc /> : null}
        </div>
      </main>
      <footer>
        <SiteFooterBar homeHref="/" current="changelog" />
      </footer>
    </>
  )
}
