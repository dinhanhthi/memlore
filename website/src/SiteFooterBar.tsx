import { ArrowUpRight } from 'lucide-react'
import { authorUrl, footer, githubUrl, legal, nav } from './content'

export function SiteFooterBar({
  homeHref,
  current,
}: {
  homeHref: string
  current?: 'privacy' | 'terms' | 'changelog'
}) {
  return (
    <div className="footer-bottom">
      <div className="footer-brand">
        <a className="wordmark" href={homeHref}>
          {nav.wordmark}
        </a>
        <p className="footer-credit">
          {footer.note}{' '}
          <a href={authorUrl} target="_blank" rel="noreferrer">
            {footer.author}
          </a>
        </p>
      </div>
      <nav className="footer-links" aria-label={legal.linksAria}>
        <a href="changelog.html" aria-current={current === 'changelog' ? 'page' : undefined}>
          {legal.changelogLink}
        </a>
        <a href="privacy.html" aria-current={current === 'privacy' ? 'page' : undefined}>
          {legal.privacyLink}
        </a>
        <a href="terms.html" aria-current={current === 'terms' ? 'page' : undefined}>
          {legal.termsLink}
        </a>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          {footer.github} <ArrowUpRight className="size-4" />
        </a>
      </nav>
    </div>
  )
}
