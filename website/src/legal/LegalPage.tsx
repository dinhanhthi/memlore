import { useEffect } from 'react'
import { legal, nav } from '../content'
import { preloadHeadSprites } from '../HeadFollowLogo'
import { SiteFooterBar } from '../SiteFooterBar'
import { SiteHeader } from '../SiteHeader'
import { isExternalHref, parseInline, parseLegalMarkdown, type LegalBlock } from './markdown'

function Inline({ text }: { text: string }) {
  return parseInline(text).map((part, index) => {
    if (part.type === 'text') return <span key={index}>{part.text}</span>
    const external = isExternalHref(part.href)
    return (
      <a
        key={index}
        href={part.href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {part.text}
      </a>
    )
  })
}

function BlockView({ block, intro }: { block: LegalBlock; intro?: boolean }) {
  if (block.type === 'h1') return <h1>{block.text}</h1>
  if (block.type === 'h2') return <h2>{block.text}</h2>
  if (block.type === 'ul') {
    return (
      <ul>
        {block.items.map((item) => (
          <li key={item}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <p className={intro ? 'legal-intro' : undefined}>
      <Inline text={block.text} />
    </p>
  )
}

export default function LegalPage({ kind, source }: { kind: 'privacy' | 'terms'; source: string }) {
  const { meta, blocks } = parseLegalMarkdown(source)
  const heading = blocks.find((block) => block.type === 'h1')
  const rest = heading ? blocks.filter((block) => block !== heading) : blocks
  const firstParagraph = rest.findIndex((block) => block.type === 'p')
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        {nav.skip}
      </a>
      <SiteHeader homeHref="/" sectionPrefix="/" />
      <main id="main" tabIndex={-1}>
        <article className="legal-article">
          {heading ? <BlockView block={heading} /> : null}
          <p className="legal-updated">
            {legal.updatedLabel} {meta.updated}
          </p>
          {rest.map((block, index) => (
            <BlockView key={index} block={block} intro={index === firstParagraph} />
          ))}
        </article>
      </main>
      <footer>
        <SiteFooterBar homeHref="/" current={kind} />
      </footer>
    </>
  )
}
