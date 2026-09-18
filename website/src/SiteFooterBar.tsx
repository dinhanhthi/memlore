import { ArrowUpRight } from 'lucide-react'
import { footer, githubUrl, legal, nav } from './content'

export function SiteFooterBar({
  homeHref,
  current,
}: {
  homeHref: string
  current?: 'privacy' | 'terms' | 'changelog' | 'about'
}) {
  return (
    <div className="footer-bottom">
      <div className="footer-brand">
        <a className="wordmark" href={homeHref}>
          {nav.wordmark}
        </a>
      </div>
      <nav className="footer-links" aria-label={legal.linksAria}>
        <a href="/about" aria-current={current === 'about' ? 'page' : undefined}>
          {legal.aboutLink}
        </a>
        <a href="/changelog" aria-current={current === 'changelog' ? 'page' : undefined}>
          {legal.changelogLink}
        </a>
        <a href="/privacy" aria-current={current === 'privacy' ? 'page' : undefined}>
          {legal.privacyLink}
        </a>
        <a href="/terms" aria-current={current === 'terms' ? 'page' : undefined}>
          {legal.termsLink}
        </a>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          {footer.github} <ArrowUpRight className="size-4" />
        </a>
      </nav>
    </div>
  )
}
