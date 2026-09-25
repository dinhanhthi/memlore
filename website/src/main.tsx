import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import LandingPage from './LandingPage'
import ChangelogPage from './changelog/ChangelogPage'
import DocsPage from './docs/DocsPage'
import { DOCS_PAGES, type DocsSlug } from './docs/manifest'
import LegalPage from './legal/LegalPage'
import aboutMarkdown from './legal/about.md?raw'
import privacyMarkdown from './legal/privacy.md?raw'
import termsMarkdown from './legal/terms.md?raw'
import { useRoute } from './router'
import './styles.css'

const docsMarkdown = import.meta.glob<string>('./docs/content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function docsSource(slug: DocsSlug): string {
  const loaded = docsMarkdown[`./docs/content/${slug}.md`]
  if (typeof loaded === 'string') return loaded
  const page = DOCS_PAGES.find((item) => item.slug === slug)
  const title = page?.title ?? slug
  const description = page?.description ?? title
  return `---
title: ${title}
description: ${description}
updated: 2026-09-25
---

# ${title}
`
}

function docsSlug(route: `docs:${DocsSlug}`): DocsSlug {
  const slug = route.slice('docs:'.length)
  const page = DOCS_PAGES.find((item) => item.slug === slug)
  if (!page) throw new Error(`unknown docs route: ${route}`)
  return page.slug
}

function Site() {
  const route = useRoute()
  switch (route) {
    case 'changelog':
      return <ChangelogPage />
    case 'privacy':
      return <LegalPage kind="privacy" source={privacyMarkdown} />
    case 'terms':
      return <LegalPage kind="terms" source={termsMarkdown} />
    case 'about':
      return <LegalPage kind="about" source={aboutMarkdown} />
    case 'home':
      return <LandingPage />
    default: {
      const slug = docsSlug(route)
      return <DocsPage slug={slug} source={docsSource(slug)} />
    }
  }
}

function BootGate({ children }: { children: ReactNode }) {
  // render() is async — flipping this class here would show the crawler twin
  // before React replaces it. Wait for the first commit.
  useEffect(() => {
    document.documentElement.classList.add('site-ready')
  }, [])
  return children
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BootGate>
      <Site />
    </BootGate>
  </StrictMode>,
)
