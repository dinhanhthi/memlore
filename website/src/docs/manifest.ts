export type DiagramName =
  | 'overview'
  | 'privacy'
  | 'encryption'
  | 'locks'
  | 'sync'
  | 'ai'
  | 'backup'
  | 'search'
  | 'memory'
  | 'persona'
  | 'customization'
  | 'maps'
  | 'editor'

export type WidgetName =
  | 'privacy-toggle'
  | 'encryption-steps'
  | 'locks-explorer'
  | 'sync-steps'
  | 'ai-provider'

/** Static diagram rendered in place of each widget in prerendered HTML. */
export const WIDGET_FALLBACK: Record<WidgetName, DiagramName> = {
  'privacy-toggle': 'privacy',
  'encryption-steps': 'encryption',
  'locks-explorer': 'locks',
  'sync-steps': 'sync',
  'ai-provider': 'ai',
}

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
    diagram: 'overview',
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
    diagram: 'backup',
  },
  {
    slug: 'search-and-media',
    title: 'Search and media',
    description: 'How search and attached photos, video, and files stay in the vault.',
    group: 'features',
    diagram: 'search',
  },
  {
    slug: 'memory',
    title: 'Memory',
    description:
      'How Memlore keeps short facts about you, and which model reads your writing to make them.',
    group: 'features',
    diagram: 'memory',
  },
  {
    slug: 'persona',
    title: 'Persona',
    description: 'How Memlore builds a private writing profile and uses it when AI writes for you.',
    group: 'features',
    diagram: 'persona',
  },
  {
    slug: 'customization',
    title: 'Customization',
    description:
      'How you change the look of the app, and which of those choices stay on this device.',
    group: 'features',
    diagram: 'customization',
  },
  {
    slug: 'maps',
    title: 'Maps',
    description: 'What a place, a map, and weather send off this device, and how you avoid that.',
    group: 'features',
    diagram: 'maps',
  },
  {
    slug: 'editor',
    title: 'Editor',
    description:
      'How each entry is its own page that saves as you write, and how two devices combine those edits.',
    group: 'features',
    diagram: 'editor',
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
