import { useEffect } from 'react'
import { preloadHeadSprites } from '../HeadFollowLogo'
import { LedgerGap, LedgerRule, SectionIndex } from '../Ledger'
import { SiteFooterBar } from '../SiteFooterBar'
import { SiteHeader } from '../SiteHeader'
import { BlockView } from '../legal/LegalPage'
import { parseLegalMarkdown, type LegalBlock } from '../legal/markdown'
import { useActiveTocAnchor } from './activeTocAnchor'
import { DOCS_PAGES, docsPath, neighbours, type DocsSlug } from './manifest'
import { buildToc } from './toc'

const DOC_GROUPS = [
  { id: 'protection', label: 'How your journal is protected' },
  { id: 'features', label: 'Features' },
] as const

function DocsNav({ slug }: { slug: DocsSlug }) {
  return (
    <>
      {DOC_GROUPS.map((group) => (
        <div key={group.id} className="docs-nav-group">
          <p className="docs-nav-heading">{group.label}</p>
          <ul>
            {DOCS_PAGES.filter((item) => item.group === group.id).map((item) => (
              <li key={item.slug}>
                <a
                  href={docsPath(item.slug)}
                  aria-current={item.slug === slug ? 'page' : undefined}
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

function DocsToc({ blocks }: { blocks: readonly LegalBlock[] }) {
  const items = buildToc(blocks)
  const active = useActiveTocAnchor(items.map((item) => item.id))
  if (items.length === 0) return null
  return (
    <nav className="docs-toc" aria-label="On this page">
      <p className="docs-toc-title">On this page</p>
      <ol>
        {items.map((item) => (
          <li key={item.id} data-depth={item.depth}>
            <a href={`#${item.id}`} aria-current={active === item.id ? 'true' : undefined}>
              {item.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

export default function DocsPage({ slug, source }: { slug: DocsSlug; source: string }) {
  const { meta, blocks } = parseLegalMarkdown(source)
  if (!DOCS_PAGES.some((item) => item.slug === slug)) {
    throw new Error(`unknown docs slug: ${slug}`)
  }
  const heading = blocks.find((block) => block.type === 'h1')
  const rest = heading ? blocks.filter((block) => block !== heading) : blocks
  const firstParagraph = rest.findIndex((block) => block.type === 'p')
  const { prev, next } = neighbours(slug)
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
        <div className="docs-layout">
          <nav className="docs-sidebar" aria-label="Documentation">
            <DocsNav slug={slug} />
          </nav>
          <details className="docs-nav-disclosure">
            <summary>All docs</summary>
            <nav aria-label="Documentation">
              <DocsNav slug={slug} />
            </nav>
          </details>
          <article className="legal-article">
            <SectionIndex>Docs</SectionIndex>
            {heading ? <BlockView block={heading} /> : null}
            <LedgerRule />
            <p className="legal-updated">Last updated {meta.updated}</p>
            <LedgerRule />
            <LedgerGap />
            {rest.map((block, index) => (
              <BlockView key={index} block={block} intro={index === firstParagraph} />
            ))}
            {prev || next ? (
              <nav className="docs-pager" aria-label="Pagination">
                {prev ? (
                  <a href={docsPath(prev.slug)} rel="prev">
                    {prev.title}
                  </a>
                ) : null}
                {next ? (
                  <a className="docs-pager-next" href={docsPath(next.slug)} rel="next">
                    {next.title}
                  </a>
                ) : null}
              </nav>
            ) : null}
          </article>
          <DocsToc blocks={blocks} />
        </div>
      </main>
      <footer>
        <LedgerRule />
        <SiteFooterBar homeHref="/" current="docs" />
      </footer>
    </>
  )
}
