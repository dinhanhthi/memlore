import { useEffect } from 'react'
import { changelog, nav } from '../content'
import { preloadHeadSprites } from '../HeadFollowLogo'
import { SiteFooterBar } from '../SiteFooterBar'
import { SiteHeader } from '../SiteHeader'
import { releases, type ChangelogRelease } from './changelogData'

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

function Release({ release }: { release: ChangelogRelease }) {
  return (
    <section className="changelog-release">
      <div className="changelog-release-head">
        <h2>v{release.version}</h2>
        {release.stable ? null : <span className="changelog-beta">{changelog.beta}</span>}
        <p className="changelog-date">
          {changelog.releasedLabel} <time dateTime={release.date}>{formatDate(release.date)}</time>
        </p>
      </div>
      {release.stable ? null : <p className="changelog-beta-note">{changelog.betaNote}</p>}
      <ul className="changelog-items">
        {release.items.map((item) => (
          <li key={item.text}>
            <span className="changelog-kind" data-kind={item.kind}>
              {changelog.kinds[item.kind]}
            </span>
            <span className="changelog-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function ChangelogPage() {
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        {nav.skip}
      </a>
      <SiteHeader homeHref="index.html" sectionPrefix="index.html" />
      <main id="main">
        <article className="changelog-article">
          <h1>{changelog.title}</h1>
          <p className="changelog-intro">{changelog.intro}</p>
          {releases.map((release) => (
            <Release key={release.version} release={release} />
          ))}
        </article>
      </main>
      <footer>
        <SiteFooterBar homeHref="index.html" current="changelog" />
      </footer>
    </>
  )
}
