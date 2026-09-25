import { useEffect } from 'react'
import { preloadHeadSprites } from '../HeadFollowLogo'
import { LedgerGap, LedgerRule, SectionIndex } from '../Ledger'
import { SiteFooterBar } from '../SiteFooterBar'
import { SiteHeader } from '../SiteHeader'
import { DIAGRAMS } from '../docs/diagrams'
import { WIDGETS } from '../docs/widgets'
import { isExternalHref, parseInline, parseLegalMarkdown, type LegalBlock } from './markdown'

export function Inline({ text }: { text: string }) {
  return parseInline(text).map((part, index) => {
    if (part.type === 'text') return <span key={index}>{part.text}</span>
    if (part.type === 'strong') return <strong key={index}>{part.text}</strong>
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

export function BlockView({ block, intro }: { block: LegalBlock; intro?: boolean }) {
  if (block.type === 'h1') return <h1>{block.text}</h1>
  if (block.type === 'h2') return <h2 id={block.id}>{block.text}</h2>
  if (block.type === 'h3') return <h3 id={block.id}>{block.text}</h3>
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
  if (block.type === 'ol') {
    return (
      <ol>
        {block.items.map((item) => (
          <li key={item}>
            <Inline text={item} />
          </li>
        ))}
      </ol>
    )
  }
  if (block.type === 'diagram') {
    return <figure dangerouslySetInnerHTML={{ __html: DIAGRAMS[block.name] }} />
  }
  if (block.type === 'details') {
    return (
      <details className="docs-details">
        <summary>
          <span>
            <Inline text={block.summary} />
          </span>
        </summary>
        {block.blocks.map((child, index) => (
          <BlockView key={index} block={child} />
        ))}
      </details>
    )
  }
  if (block.type === 'cards') {
    return (
      <ul className="docs-cards">
        {block.items.map((item, index) => (
          <li key={index}>
            <strong>{item.title}</strong>
            <span>
              <Inline text={item.text} />
            </span>
          </li>
        ))}
      </ul>
    )
  }
  if (block.type === 'widget') {
    const Widget = WIDGETS[block.name]
    return <Widget />
  }
  return (
    <p className={intro ? 'legal-intro' : undefined}>
      <Inline text={block.text} />
    </p>
  )
}

export default function LegalPage({
  kind,
  source,
}: {
  kind: 'privacy' | 'terms' | 'about'
  source: string
}) {
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
        Skip to content
      </a>
      <SiteHeader homeHref="/" sectionPrefix="/" />
      <main id="main" className="ledger" tabIndex={-1}>
        <article className="legal-article">
          <SectionIndex>{kind === 'about' ? 'About' : 'Legal'}</SectionIndex>
          {heading ? <BlockView block={heading} /> : null}
          <LedgerRule />
          <p className="legal-updated">Last updated {meta.updated}</p>
          <LedgerRule />
          <LedgerGap />
          {rest.map((block, index) => (
            <BlockView key={index} block={block} intro={index === firstParagraph} />
          ))}
        </article>
      </main>
      <footer>
        <LedgerRule />
        <SiteFooterBar homeHref="/" current={kind} />
      </footer>
    </>
  )
}
