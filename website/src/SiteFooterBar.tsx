import { ArrowUpRight } from 'lucide-react'
import { githubUrl } from './links'

const FOOTER_WORDMARK = 'Memlore'

export function SiteFooterBar({
  homeHref,
  current,
}: {
  homeHref: string
  current?: 'privacy' | 'terms' | 'changelog' | 'about' | 'docs'
}) {
  return (
    <>
      <p className="footer-copyright">© {new Date().getFullYear()} Memlore. All rights reserved.</p>
      <div className="footer-bottom">
        <div className="footer-brand">
          <a className="footer-wordmark" href={homeHref}>
            {Array.from(FOOTER_WORDMARK).map((letter, index) => (
              <span className="footer-wordmark-letter" key={index}>
                {letter}
              </span>
            ))}
          </a>
        </div>
        <nav className="footer-links" aria-label="About, changelog, privacy, terms, and GitHub">
          <a href="/about" aria-current={current === 'about' ? 'page' : undefined}>
            About
          </a>
          <a href="/changelog" aria-current={current === 'changelog' ? 'page' : undefined}>
            Changelog
          </a>
          <a href="/privacy" aria-current={current === 'privacy' ? 'page' : undefined}>
            Privacy
          </a>
          <a href="/terms" aria-current={current === 'terms' ? 'page' : undefined}>
            Terms
          </a>
          <a href={githubUrl} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight className="size-4" />
          </a>
        </nav>
      </div>
    </>
  )
}
