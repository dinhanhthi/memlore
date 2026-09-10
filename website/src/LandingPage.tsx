import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Fingerprint,
  GitBranch,
  Laptop,
  LockKeyhole,
  Maximize2,
  MessageCircle,
  Monitor,
  PenLine,
  RotateCcw,
  Search,
  Smartphone,
  Sparkles,
} from 'lucide-react'
import {
  comparison,
  demo,
  features,
  footer,
  githubUrl,
  hero,
  nav,
  openSource,
  platforms,
} from './content'
import { isDesignSystem, isTrustedIframeEvent, sendDemoCommand } from './demoBridge'
import type { DemoView, DesignSystem } from './demoBridge'

const logo = './logo-without-container/logo-straight-512.png'
const tourIcons = {
  write: PenLine,
  explore: Search,
  chat: MessageCircle,
  locks: LockKeyhole,
} as const
const featureIcons = {
  writing: PenLine,
  find: Search,
  locks: LockKeyhole,
  ai: Sparkles,
  sync: Cloud,
  appearance: BookOpen,
} as const
const platformIcons = {
  macOS: Laptop,
  'Windows & Linux': Monitor,
  'iOS & Android': Smartphone,
} as const

function Demo() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [theme, setTheme] = useState<DesignSystem>('signature')
  const [view, setView] = useState<DemoView>('write')
  const themeRef = useRef(theme)
  useEffect(() => {
    document.documentElement.dataset.designSystem = theme
    document.documentElement.style.colorScheme = 'dark'
    themeRef.current = theme
  }, [theme])
  useEffect(() => {
    const timer = window.setTimeout(
      () => setStatus((current) => (current === 'loading' ? 'error' : current)),
      30000,
    )
    const listener = (event: MessageEvent) => {
      if (!isTrustedIframeEvent(event, frame.current?.contentWindow)) return
      if (event.data.type === 'memlore-demo-ready') {
        setStatus('ready')
        window.clearTimeout(timer)
        sendDemoCommand(frame.current, { command: 'theme', designSystem: themeRef.current })
      } else setTheme(event.data.designSystem)
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      window.clearTimeout(timer)
    }
  }, [attempt])
  const changeTheme = (designSystem: DesignSystem) => {
    setTheme(designSystem)
    sendDemoCommand(frame.current, { command: 'theme', designSystem })
  }
  return (
    <section className="demo-section" id="demo" aria-labelledby="demo-title">
      <div className="section-heading demo-heading">
        <div>
          <h2 id="demo-title">{demo.title}</h2>
          <p>{demo.subtitle}</p>
        </div>
        <span className="demo-tag">
          <span />
          {demo.tag}
        </span>
      </div>
      <div className="workbench">
        <div className="demo-toolbar">
          <div className="tour-buttons" aria-label={demo.tourAria}>
            {demo.tour.map(({ view: key, label }) => {
              const Icon = tourIcons[key]
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={view === key}
                  disabled={status !== 'ready'}
                  onClick={() => {
                    setView(key)
                    sendDemoCommand(frame.current, { command: 'navigate', view: key })
                  }}
                >
                  <Icon className="size-4" />
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          <label className="theme-picker">
            {demo.themeLabel}
            <select
              aria-label={demo.themeAria}
              value={theme}
              onChange={(event) => {
                if (isDesignSystem(event.target.value)) changeTheme(event.target.value)
              }}
            >
              <option value="signature">{demo.themes.signature}</option>
              <option value="clean">{demo.themes.clean}</option>
              <option value="clay">{demo.themes.clay}</option>
            </select>
            <ChevronDown className="size-3.5" />
          </label>
        </div>
        <p className="demo-mobile-hint">
          {demo.mobileHintBefore}{' '}
          <a href="./demo.html" target="_blank" rel="noreferrer">
            {demo.mobileHintLink}
          </a>
          .
        </p>
        <div className="demo-viewport">
          <iframe
            ref={frame}
            key={attempt}
            src="./demo.html"
            title={demo.iframeTitle}
            onError={() => setStatus('error')}
          />
          {status !== 'ready' && (
            <div className="demo-status" role="status">
              <BookOpen className="size-8" />
              <h3>{status === 'loading' ? demo.loadingTitle : demo.errorTitle}</h3>
              <p>{status === 'loading' ? demo.loadingText : demo.errorText}</p>
              {status === 'error' && (
                <div className="button-row">
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setStatus('loading')
                      setAttempt((value) => value + 1)
                    }}
                  >
                    {demo.tryAgain}
                  </button>
                  <a className="text-link" href="./demo.html" target="_blank" rel="noreferrer">
                    {demo.openDemo} <ArrowUpRight className="size-4" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="demo-caption">
          <p aria-live="polite">{demo.tour.find((item) => item.view === view)?.description}</p>
          <div>
            <button
              type="button"
              disabled={status !== 'ready'}
              onClick={() => {
                sendDemoCommand(frame.current, { command: 'reset' })
                setView('write')
              }}
            >
              <RotateCcw className="size-3.5" /> {demo.reset}
            </button>
            <a href="./demo.html" target="_blank" rel="noreferrer">
              <Maximize2 className="size-3.5" /> {demo.openSeparately}
            </a>
          </div>
        </div>
      </div>
      <p className="demo-disclaimer">{demo.disclaimer}</p>
    </section>
  )
}

export default function LandingPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        {nav.skip}
      </a>
      <header className="site-header">
        <a className="wordmark" href="#" aria-label={nav.homeAria}>
          <img src={logo} width="38" height="38" alt="" />
          {nav.wordmark}
        </a>
        <nav aria-label={nav.mainAria}>
          <a href="#demo">{nav.demo}</a>
          <a href="#features">{nav.features}</a>
          <a href="#compare">{nav.compare}</a>
          <details className="doc-menu">
            <summary>{nav.doc}</summary>
            <p>
              {nav.docDisclosure} <a href={githubUrl}>{nav.docReadme}</a>.
            </p>
          </details>
        </nav>
        <a className="github-link" href={githubUrl} target="_blank" rel="noreferrer">
          <GitBranch className="size-4.5" />
          <span>{nav.github}</span>
          <ArrowUpRight className="size-3.5" />
        </a>
      </header>
      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <p className="release-note">
              <span />
              {hero.note}
            </p>
            <h1>
              {hero.titleLead}
              <br />
              <span>{hero.titleAccent}</span>
            </h1>
            <p className="hero-description">{hero.description}</p>
            <div className="button-row">
              <a className="button primary" href="#demo">
                {hero.tryDemo} <ArrowDown className="size-4" />
              </a>
              <a className="text-link" href={githubUrl} target="_blank" rel="noreferrer">
                {hero.followGithub} <ArrowUpRight className="size-4" />
              </a>
            </div>
            <p className="availability">
              <Laptop className="size-4" /> {hero.availability}
            </p>
          </div>
          <div className="hero-portrait">
            <div className="mascot-halo">
              <img src={logo} alt={hero.mascotAlt} width="320" height="320" />
            </div>
            <p>
              {hero.portraitLead}
              <br />
              <span>{hero.portraitAccent}</span>
            </p>
          </div>
        </section>
        <Demo />
        <section className="features-section" id="features">
          <div className="feature-intro">
            <h2>
              {features.titleLead}
              <br />
              {features.titleAccent}
            </h2>
            <p>{features.intro}</p>
            <div className="local-note">
              <Fingerprint className="size-7" />
              <div>
                <h3>{features.localTitle}</h3>
                <p>{features.localText}</p>
              </div>
            </div>
          </div>
          <div className="benefit-list">
            {features.items.map(({ id, title, text }) => {
              const Icon = featureIcons[id]
              return (
                <article key={id}>
                  <Icon className="size-5" />
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
        <section className="open-section" id="open-source">
          <div className="open-symbol" aria-hidden="true">
            <Code2 className="size-16" strokeWidth={1} />
            <span>{openSource.symbol}</span>
          </div>
          <div>
            <h2>
              {openSource.titleLead}
              <br />
              {openSource.titleAccent}
            </h2>
            <p>{openSource.body}</p>
            <p>{openSource.beta}</p>
            <a className="text-link" href={githubUrl} target="_blank" rel="noreferrer">
              {openSource.github} <ArrowUpRight className="size-4.5" />
            </a>
          </div>
        </section>
        <section className="compare-section" id="compare">
          <div className="section-heading">
            <div>
              <h2>{comparison.title}</h2>
              <p>{comparison.intro}</p>
            </div>
          </div>
          <div
            className="comparison-scroll"
            tabIndex={0}
            role="region"
            aria-label={comparison.tableAria}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">{comparison.columns.journal}</th>
                  <th scope="col">{comparison.columns.strength}</th>
                  <th scope="col">{comparison.columns.tradeoff}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.products.map((product) => (
                  <tr
                    key={product.name}
                    className={product.name === 'Memlore' ? 'memlore-row' : undefined}
                  >
                    <th scope="row">
                      {product.name === 'Memlore' && (
                        <img src={logo} alt="" width="28" height="28" />
                      )}
                      {product.name}
                      {product.badge ? <span>{product.badge}</span> : null}
                    </th>
                    <td>{product.strength}</td>
                    <td>{product.tradeoff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="comparison-sources">
            {comparison.sourcesLead}{' '}
            {comparison.products
              .filter((product) => product.sourceUrl)
              .map((product) => (
                <a key={product.name} href={product.sourceUrl} target="_blank" rel="noreferrer">
                  {product.name} <ArrowUpRight className="size-3" />
                </a>
              ))}
            <span>{comparison.sourcesNote}</span>
          </p>
        </section>
        <section className="platform-section">
          <div>
            <h2>
              {platforms.titleLead}
              <br />
              {platforms.titleAccent}
            </h2>
            <p>{platforms.intro}</p>
          </div>
          <div className="platform-list">
            {platforms.items.map((item) => {
              const Icon = platformIcons[item.name]
              return (
                <div key={item.name}>
                  <Icon className="size-5.5" />
                  <span>{item.name}</span>
                  {item.name === 'macOS' ? (
                    <strong>
                      <Check className="size-3.5" /> {item.status}
                    </strong>
                  ) : (
                    <small>{item.status}</small>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      </main>
      <footer>
        <div className="footer-main">
          <img src={logo} width="64" height="64" alt="" />
          <h2>
            {footer.titleLead}
            <br />
            {footer.titleAccent}
          </h2>
          <a className="button primary" href="#demo">
            {footer.tryDemo} <ArrowRight className="size-4" />
          </a>
        </div>
        <div className="footer-bottom">
          <a className="wordmark" href="#">
            {nav.wordmark}
          </a>
          <p>{footer.note}</p>
          <a href={githubUrl} target="_blank" rel="noreferrer">
            {footer.github} <ArrowUpRight className="size-4" />
          </a>
        </div>
      </footer>
    </>
  )
}
