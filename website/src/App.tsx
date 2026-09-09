import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Brain,
  Check,
  Cloud,
  Download,
  FileText,
  Globe2,
  Image,
  Laptop,
  Lock,
  MapPin,
  Menu,
  Moon,
  Search,
  Shield,
  Sparkles,
  Tags,
  X,
} from 'lucide-react'
import { docSections } from './content/docs'
import { featureGroups, heroStats, privacyPrinciples, roadmapItems } from './content/features'
import {
  getRecommendedPlatform,
  isPlatformEnabled,
  PLATFORM_DOWNLOADS,
  type PlatformDownload,
} from './lib/platform'

type Route = '/' | '/docs' | '/download'

const navItems: Array<{ href: Route; label: string }> = [
  { href: '/', label: 'Home' },
  { href: '/docs', label: 'Docs' },
  { href: '/download', label: 'Download' },
]

const appFeatures = [
  {
    icon: <BookOpen />,
    title: 'Rich journaling',
    body: 'Markdown shortcuts, tables, checklists, code blocks, templates, prompts, and autosave.',
  },
  {
    icon: <Search />,
    title: 'Fast search',
    body: 'Full-text search plus semantic search when an AI provider is enabled.',
  },
  {
    icon: <Tags />,
    title: 'Organize naturally',
    body: 'Journals, tags, favorites, calendar filters, streaks, and mood metadata.',
  },
  {
    icon: <Image />,
    title: 'Media memories',
    body: 'Images, video, audio notes, thumbnails, gallery browsing, and encrypted media cache.',
  },
  {
    icon: <MapPin />,
    title: 'Places and weather',
    body: 'Location picker, EXIF location, location aliases, maps, and Open-Meteo weather.',
  },
  {
    icon: <Brain />,
    title: 'Opt-in intelligence',
    body: 'Titles, summaries, reflection prompts, Daily Chat, and local-provider friendly AI.',
  },
]

function normalizeRoute(pathname: string): Route {
  if (pathname === '/docs') return '/docs'
  if (pathname === '/download') return '/download'
  return '/'
}

function useRoute() {
  const [route, setRoute] = useState<Route>(() => normalizeRoute(window.location.pathname))

  useEffect(() => {
    const handlePopState = () => setRoute(normalizeRoute(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  function navigate(href: Route) {
    if (href === route) return
    window.history.pushState({}, '', href)
    setRoute(href)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  return { route, navigate }
}

export function App() {
  const { route, navigate } = useRoute()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setMenuOpen(false)
  }, [route])

  return (
    <div className="site-shell">
      <SkyBackground />
      <Header route={route} navigate={navigate} menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
      <main>
        {route === '/' && <HomePage navigate={navigate} />}
        {route === '/docs' && <DocsPage />}
        {route === '/download' && <DownloadPage />}
      </main>
      <Footer navigate={navigate} />
    </div>
  )
}

function SkyBackground() {
  return (
    <div className="sky-bg" aria-hidden="true">
      <span className="sky-orb sky-orb-one" />
      <span className="sky-orb sky-orb-two" />
      <span className="sky-orb sky-orb-three" />
    </div>
  )
}

function Header({
  route,
  navigate,
  menuOpen,
  setMenuOpen,
}: {
  route: Route
  navigate: (route: Route) => void
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
}) {
  return (
    <header className="site-header">
      <button
        className="brand"
        type="button"
        onClick={() => navigate('/')}
        aria-label="Memlore home"
      >
        <img src="/logo-without-container/256.png" alt="" />
        <span>Memlore</span>
      </button>
      <nav className="desktop-nav" aria-label="Primary">
        {navItems.map((item) => (
          <button
            key={item.href}
            type="button"
            className={route === item.href ? 'nav-link active' : 'nav-link'}
            onClick={() => navigate(item.href)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <button type="button" className="ghost-button" onClick={() => navigate('/docs')}>
          Read docs
        </button>
        <button
          type="button"
          className="primary-button compact"
          onClick={() => navigate('/download')}
        >
          <Download size={16} aria-hidden="true" />
          Download
        </button>
        <button
          type="button"
          className="menu-button"
          aria-expanded={menuOpen}
          aria-label="Toggle navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
      </div>
      {menuOpen && (
        <nav className="mobile-nav" aria-label="Mobile primary">
          {navItems.map((item) => (
            <button key={item.href} type="button" onClick={() => navigate(item.href)}>
              {item.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  )
}

function HomePage({ navigate }: { navigate: (route: Route) => void }) {
  return (
    <>
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">Private journaling for people who mean it</p>
          <h1>Memlore keeps your inner life local, encrypted, and searchable.</h1>
          <p className="hero-lede">
            A calm desktop journal with rich writing, media, maps, statistics, optional encrypted
            sync, and AI that only runs when you choose a provider.
          </p>
          <div className="hero-actions">
            <button type="button" className="primary-button" onClick={() => navigate('/download')}>
              Download for macOS
              <ArrowRight size={18} aria-hidden="true" />
            </button>
            <button type="button" className="secondary-button" onClick={() => navigate('/docs')}>
              Explore docs
            </button>
          </div>
          <div className="stat-row" aria-label="Product principles">
            {heroStats.map((stat) => (
              <div className="stat" key={stat.label}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
        <AppPreview />
      </section>

      <section className="section">
        <div className="section-heading">
          <p className="eyebrow">Features</p>
          <h2>Everything around the writing is useful, quiet, and private.</h2>
        </div>
        <div className="feature-grid">
          {appFeatures.map((feature) => (
            <article className="feature-card" key={feature.title}>
              <div className="icon-chip">{feature.icon}</div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section split-section">
        {featureGroups.map((group) => (
          <article className="story-panel" key={group.title}>
            <p className="eyebrow">{group.eyebrow}</p>
            <h2>{group.title}</h2>
            <p>{group.body}</p>
            <ul className="check-list">
              {group.features.map((feature) => (
                <li key={feature}>
                  <Check size={16} aria-hidden="true" />
                  {feature}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="section privacy-band">
        <div>
          <p className="eyebrow">Privacy model</p>
          <h2>No tracking, no server, no recovery backdoor.</h2>
          <p>
            Memlore is built around the awkward but honest truth of strong privacy: your data
            belongs to you, and the app should not be able to quietly read it.
          </p>
        </div>
        <div className="privacy-grid">
          {privacyPrinciples.map((principle) => (
            <article key={principle.title}>
              <Shield size={20} aria-hidden="true" />
              <h3>{principle.title}</h3>
              <p>{principle.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-heading">
          <p className="eyebrow">Roadmap</p>
          <h2>macOS is first. Other platforms are visible, but not pretend-shipped.</h2>
        </div>
        <div className="roadmap-grid">
          {roadmapItems.map((item) => (
            <article className="roadmap-card" key={item.title}>
              <span>{item.status}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="cta-band">
        <div>
          <p className="eyebrow">Download</p>
          <h2>Start with the macOS build today.</h2>
          <p>
            Windows, Linux, iOS, and Android are planned after the macOS reference release is
            complete.
          </p>
        </div>
        <button type="button" className="primary-button" onClick={() => navigate('/download')}>
          View downloads
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </section>
    </>
  )
}

function AppPreview() {
  return (
    <div className="app-preview" aria-label="Memlore app preview">
      <div className="preview-titlebar">
        <span />
        <span />
        <span />
        <strong>Memlore</strong>
      </div>
      <div className="preview-body">
        <aside>
          <div className="preview-pill active">All entries</div>
          <div className="preview-pill">Favorites</div>
          <div className="preview-pill">Calendar</div>
          <div className="preview-pill">Tags</div>
        </aside>
        <section className="preview-list">
          <article className="preview-entry active">
            <span>Today</span>
            <strong>Small rituals</strong>
            <p>Coffee, rain, and a quiet hour before the day opened.</p>
          </article>
          <article className="preview-entry">
            <span>Yesterday</span>
            <strong>Evening walk</strong>
            <p>Blue hour over the river. Remember this light.</p>
          </article>
        </section>
        <section className="preview-editor">
          <div className="preview-toolbar">
            <span>May 15</span>
            <span>Calm</span>
            <span>Paris</span>
          </div>
          <h3>Small rituals</h3>
          <p>
            The best entries are not dramatic. They catch the texture of a day before it slips into
            the general blur.
          </p>
          <div className="preview-media-row">
            <img
              src="https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=400&q=80"
              alt="Morning coffee"
              loading="lazy"
            />
            <img
              src="https://images.unsplash.com/photo-1431440869543-efaf3388c585?auto=format&fit=crop&w=400&q=80"
              alt="Rain on the window"
              loading="lazy"
            />
            <img
              src="https://images.unsplash.com/photo-1481627834876-b7833e8f5570?auto=format&fit=crop&w=400&q=80"
              alt="A quiet stack of books"
              loading="lazy"
            />
          </div>
        </section>
      </div>
    </div>
  )
}

function DocsPage() {
  return (
    <section className="page-section docs-layout">
      <aside className="docs-nav" aria-label="Docs sections">
        <p className="eyebrow">Docs</p>
        {docSections.map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            {section.title}
          </a>
        ))}
      </aside>
      <div className="docs-content">
        <div className="page-heading">
          <p className="eyebrow">Documentation</p>
          <h1>Learn Memlore from the privacy model outward.</h1>
          <p>
            These docs are a starter home for user-facing guidance. The content is typed in source
            so future sections can be expanded without rewriting the page layout.
          </p>
        </div>
        {docSections.map((section) => (
          <article className="doc-card" id={section.id} key={section.id}>
            <h2>{section.title}</h2>
            <p>{section.summary}</p>
            <ul className="check-list">
              {section.bullets.map((bullet) => (
                <li key={bullet}>
                  <Check size={16} aria-hidden="true" />
                  {bullet}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  )
}

function DownloadPage() {
  const recommended = useMemo(() => getRecommendedPlatform(), [])

  return (
    <section className="page-section">
      <div className="page-heading">
        <p className="eyebrow">Download</p>
        <h1>Choose your platform.</h1>
        <p>
          Memlore is cross-platform by design, but the public app is staged honestly: macOS is
          enabled now, and the rest are coming after the macOS v1.0 reference release.
        </p>
      </div>
      {recommended && (
        <div className="recommendation" data-testid="platform-recommendation">
          <Sparkles size={18} aria-hidden="true" />
          <span>
            We detected <strong>{recommended.name}</strong>.{' '}
            {isPlatformEnabled(recommended)
              ? 'The macOS download is ready.'
              : `${recommended.name} is on the roadmap. The macOS build is available today.`}
          </span>
        </div>
      )}
      {!recommended && (
        <div className="recommendation" data-testid="platform-recommendation">
          <Globe2 size={18} aria-hidden="true" />
          <span>We could not detect your platform. The macOS build is available today.</span>
        </div>
      )}
      <div className="download-grid">
        {PLATFORM_DOWNLOADS.map((platform) => (
          <PlatformCard
            key={platform.id}
            platform={platform}
            recommended={recommended?.id === platform.id}
          />
        ))}
      </div>
    </section>
  )
}

function PlatformCard({
  platform,
  recommended,
}: {
  platform: PlatformDownload
  recommended: boolean
}) {
  const enabled = isPlatformEnabled(platform)
  return (
    <article className={recommended ? 'platform-card recommended' : 'platform-card'}>
      <div className="platform-card-top">
        <div className="icon-chip large">
          {platform.id === 'macos' && <Laptop aria-hidden="true" />}
          {platform.id === 'windows' && <Moon aria-hidden="true" />}
          {platform.id === 'linux' && <FileText aria-hidden="true" />}
          {platform.id === 'ios' && <Cloud aria-hidden="true" />}
          {platform.id === 'android' && <Globe2 aria-hidden="true" />}
        </div>
        <div>
          <h2>{platform.name}</h2>
          <span className={enabled ? 'status-badge available' : 'status-badge'}>
            {enabled ? 'Available' : 'Coming soon'}
          </span>
        </div>
      </div>
      <p>{platform.description}</p>
      {enabled ? (
        <a className="primary-button full-width" href={platform.href}>
          {platform.ctaLabel}
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      ) : (
        <button className="disabled-button" type="button" disabled>
          {platform.ctaLabel}
        </button>
      )}
      {recommended && <p className="recommended-note">Recommended for this device</p>}
    </article>
  )
}

function Footer({ navigate }: { navigate: (route: Route) => void }) {
  return (
    <footer className="site-footer">
      <div>
        <button className="brand footer-brand" type="button" onClick={() => navigate('/')}>
          <img src="/logo-without-container/256.png" alt="" />
          <span>Memlore</span>
        </button>
        <p>
          Private, local-first journaling. Built with Tauri, React, SQLite, Yjs, and a healthy
          respect for locked doors.
        </p>
      </div>
      <div className="footer-links">
        <button type="button" onClick={() => navigate('/docs')}>
          Docs
        </button>
        <button type="button" onClick={() => navigate('/download')}>
          Download
        </button>
        <a href="https://github.com/dinhanhthi/memlore">
          <FileText size={16} aria-hidden="true" />
          GitHub
        </a>
        <span>
          <Lock size={16} aria-hidden="true" />
          Zero telemetry
        </span>
      </div>
    </footer>
  )
}
