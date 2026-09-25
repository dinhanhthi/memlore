export type DiagramName = 'privacy' | 'encryption' | 'locks' | 'sync' | 'ai'

export type DocsSlug =
  | 'overview'
  | 'how-privacy-works'
  | 'encryption'
  | 'locks'
  | 'sync'
  | 'ai'
  | 'backup-and-recovery'
  | 'search-and-media'
  | 'memory'
  | 'persona'
  | 'customization'
  | 'maps'
  | 'editor'

export type DocsPage = {
  slug: DocsSlug
  title: string
  description: string
  group: 'protection' | 'features'
  diagram?: DiagramName
}

export const DOCS_PAGES: readonly DocsPage[] = [
  {
    slug: 'overview',
    title: 'Overview',
    description: 'A plain-language map of how Memlore works.',
    group: 'protection',
  },
  {
    slug: 'how-privacy-works',
    title: 'How privacy works',
    description: 'What stays on your device, and what only leaves when you turn a feature on.',
    group: 'protection',
    diagram: 'privacy',
  },
  {
    slug: 'encryption',
    title: 'Encryption',
    description: 'How your journal is encrypted, and what the recovery sheet is for.',
    group: 'protection',
    diagram: 'encryption',
  },
  {
    slug: 'locks',
    title: 'Locks',
    description: 'How the app lock, an invisible vault, and a second lock hide entries.',
    group: 'protection',
    diagram: 'locks',
  },
  {
    slug: 'sync',
    title: 'Sync',
    description: 'How encrypted journal files move between your own devices.',
    group: 'features',
    diagram: 'sync',
  },
  {
    slug: 'ai',
    title: 'AI',
    description: 'How optional AI features use your journal, and what they do not send.',
    group: 'features',
    diagram: 'ai',
  },
  {
    slug: 'backup-and-recovery',
    title: 'Backup and recovery',
    description: 'How to keep a copy, and what you need if you lose the password.',
    group: 'features',
  },
  {
    slug: 'search-and-media',
    title: 'Search and media',
    description: 'How search and attached photos, video, and files stay in the vault.',
    group: 'features',
  },
  {
    slug: 'memory',
    title: 'Memory',
    description: 'How Memlore keeps facts you ask it to remember.',
    group: 'features',
  },
  {
    slug: 'persona',
    title: 'Persona',
    description: 'How a writing persona changes replies when you write with AI.',
    group: 'features',
  },
  {
    slug: 'customization',
    title: 'Customization',
    description: 'How themes, fonts, and design systems change the look of the app.',
    group: 'features',
  },
  {
    slug: 'maps',
    title: 'Maps',
    description: 'How a place on an entry uses map and weather services.',
    group: 'features',
  },
  {
    slug: 'editor',
    title: 'Editor',
    description: 'How each entry is one document you write and reopen later.',
    group: 'features',
  },
]

export function docsPath(slug: DocsSlug): string {
  return slug === 'overview' ? '/docs/' : `/docs/${slug}`
}

export function docsRouteKey(slug: DocsSlug): string {
  return slug === 'overview' ? '/docs' : `/docs/${slug}`
}

export function docsShellFile(slug: DocsSlug): string {
  return slug === 'overview' ? 'docs/index.html' : `docs/${slug}.html`
}

export function neighbours(slug: DocsSlug): { prev?: DocsPage; next?: DocsPage } {
  const index = DOCS_PAGES.findIndex((page) => page.slug === slug)
  return {
    prev: DOCS_PAGES[index - 1],
    next: DOCS_PAGES[index + 1],
  }
}
