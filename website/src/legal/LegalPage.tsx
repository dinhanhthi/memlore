import { useEffect, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import {
  authorUrl,
  contactEmail,
  footer,
  githubUrl,
  legal,
  nav,
  privacy,
  type LegalSection,
} from '../content'
import HeadFollowLogo, { preloadHeadSprites } from '../HeadFollowLogo'

const POLICY_LABEL = 'Google API Services User Data Policy'

export type LegalDoc = {
  heading: string
  intro: string
  title: string
  description: string
  sections: LegalSection[]
  googleUserDataPolicyUrl?: string
}

function interpolate(
  text: string,
  needle: string,
  render: (key: string) => ReactNode,
  keyPrefix: string,
): ReactNode[] {
  const parts = text.split(needle)
  if (parts.length === 1) return [text]
  const nodes: ReactNode[] = []
  parts.forEach((part, index) => {
    if (part) nodes.push(part)
    if (index < parts.length - 1) nodes.push(render(`${keyPrefix}-${index}`))
  })
  return nodes
}

function LinkedText({ text, policyUrl }: { text: string; policyUrl?: string }) {
  const withEmail = interpolate(
    text,
    contactEmail,
    (key) => (
      <a key={key} href={`mailto:${contactEmail}`}>
        {contactEmail}
      </a>
    ),
    'email',
  )
  if (!policyUrl) return withEmail
  return withEmail.flatMap((node, index) => {
    if (typeof node !== 'string') return [node]
    return interpolate(
      node,
      POLICY_LABEL,
      (key) => (
        <a key={key} href={policyUrl} target="_blank" rel="noreferrer">
          {POLICY_LABEL}
        </a>
      ),
      `policy-${index}`,
    )
  })
}

function LegalFooter({ current }: { current: 'privacy' | 'terms' }) {
  return (
    <footer>
      <div className="footer-bottom">
        <p className="footer-credit">
          {footer.note}{' '}
          <a href={authorUrl} target="_blank" rel="noreferrer">
            {footer.author}
          </a>
        </p>
        <nav className="footer-legal" aria-label={`${legal.privacyLink} and ${legal.termsLink}`}>
          <a href="privacy.html" aria-current={current === 'privacy' ? 'page' : undefined}>
            {legal.privacyLink}
          </a>
          <a href="terms.html" aria-current={current === 'terms' ? 'page' : undefined}>
            {legal.termsLink}
          </a>
        </nav>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          {footer.github} <ArrowUpRight className="size-4" />
        </a>
      </div>
    </footer>
  )
}

export default function LegalPage({ doc }: { doc: LegalDoc }) {
  const current = doc.heading === privacy.heading ? 'privacy' : 'terms'
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        {nav.skip}
      </a>
      <header className="site-header">
        <a className="wordmark" href="index.html" aria-label={legal.homeAria}>
          <HeadFollowLogo alt="" className="wordmark-head" size={36} />
          {nav.wordmark}
        </a>
      </header>
      <main id="main">
        <article className="legal-article">
          <h1>{doc.heading}</h1>
          <p className="legal-updated">
            {legal.updatedLabel} {legal.updated}
          </p>
          <p className="legal-intro">
            <LinkedText text={doc.intro} policyUrl={doc.googleUserDataPolicyUrl} />
          </p>
          {doc.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h2>{section.heading}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>
                  <LinkedText text={paragraph} policyUrl={doc.googleUserDataPolicyUrl} />
                </p>
              ))}
              {section.bullets ? (
                <ul>
                  {section.bullets.map((item) => (
                    <li key={item}>
                      <LinkedText text={item} policyUrl={doc.googleUserDataPolicyUrl} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </article>
      </main>
      <LegalFooter current={current} />
    </>
  )
}
