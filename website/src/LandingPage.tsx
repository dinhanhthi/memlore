import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  CalendarClock,
  Check,
  Code2,
  Cpu,
  Download,
  EyeOff,
  FileText,
  GitBranch,
  Heading,
  Heart,
  Highlighter,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  Laptop,
  Lightbulb,
  Lock,
  LockKeyhole,
  Maximize2,
  MessageCircle,
  MessageSquareQuote,
  Mic,
  Monitor,
  PenLine,
  RotateCcw,
  ScanSearch,
  Search,
  Shield,
  Smartphone,
  Sparkles,
  Video,
  X,
} from 'lucide-react'
import {
  ai,
  chat,
  comparison,
  demo,
  editor,
  encrypt,
  footer,
  githubUrl,
  hero,
  locations,
  locks,
  nav,
  openSource,
  persona,
  platforms,
  search,
  transfer,
  type ComparisonMark,
} from './content'
import { DEFAULT_DESIGN_SYSTEM, isTrustedIframeEvent, sendDemoCommand } from './demoBridge'
import type { DemoView, DesignSystem } from './demoBridge'
import HeadFollowLogo, { preloadHeadSprites } from './HeadFollowLogo'
import { NATURAL_EARTH_LAND_D } from './naturalEarthLand'

const tourIcons = {
  write: PenLine,
  explore: Search,
  chat: MessageCircle,
  locks: LockKeyhole,
} as const
const aiIcons = {
  titles: Heading,
  summaries: Highlighter,
  deeper: Lightbulb,
  chat: MessageCircle,
  ask: MessageSquareQuote,
  search: ScanSearch,
  emotion: Heart,
  time: CalendarClock,
  image: ImagePlus,
  device: Cpu,
} as const
const lockIcons = {
  app: Lock,
  second: KeyRound,
  invisible: EyeOff,
} as const
const platformIcons = {
  macOS: Laptop,
  'Windows & Linux': Monitor,
  'iOS & Android': Smartphone,
} as const
const editorMediaFiles = [
  { id: 'image', Icon: ImageIcon },
  { id: 'video', Icon: Video },
  { id: 'audio', Icon: Mic },
] as const

function DownloadLink({
  className,
  label,
  ariaLabel,
}: {
  className: string
  label: string
  ariaLabel: string
}) {
  return (
    <a
      className={className}
      href={githubUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
    >
      <span className="download-mark" aria-hidden="true">
        <Download className="size-4" />
      </span>
      <span>{label}</span>
    </a>
  )
}

function MarkIcon({ mark, label }: { mark: ComparisonMark; label: string }) {
  if (mark === 'yes') {
    return (
      <span className="mark mark-yes" aria-label={label}>
        <Check className="size-4" aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'no') {
    return (
      <span className="mark mark-no" aria-label={label}>
        <X className="size-4" aria-hidden="true" />
      </span>
    )
  }
  return (
    <span className="mark mark-partial" aria-label={label}>
      —
    </span>
  )
}

function EncryptArrow() {
  return (
    <svg className="encrypt-arrow" viewBox="0 0 72 40" aria-hidden="true">
      <path className="encrypt-dash" d="M8 11 H54" />
      <path d="M48 6 L58 11 L48 16" />
      <path className="encrypt-dash" d="M64 29 H18" />
      <path d="M24 24 L14 29 L24 34" />
    </svg>
  )
}

function EncryptFigure() {
  return (
    <figure className="illust illust-encrypt" aria-hidden="true">
      <div className="encrypt-scene">
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <FileText className="size-8" />
          </div>
          <small>{encrypt.figure.words}</small>
        </article>
        <EncryptArrow />
        <article className="encrypt-card encrypt-card-lock">
          <div className="encrypt-card-body">
            <span className="encrypt-orbit" />
            <LockKeyhole className="size-6" />
          </div>
          <small>{encrypt.figure.password}</small>
        </article>
        <EncryptArrow />
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <Shield className="size-8" />
          </div>
          <small>{encrypt.figure.sealed}</small>
        </article>
        <p className="encrypt-unseen">
          <EyeOff className="size-5" />
          {encrypt.figure.unseen}
        </p>
      </div>
    </figure>
  )
}

function LocksFigure() {
  const [app, second, invisible] = locks.items
  const AppIcon = lockIcons.app
  const SecondIcon = lockIcons.second
  const InvisibleIcon = lockIcons.invisible
  return (
    <figure className="illust illust-locks" aria-hidden="true">
      <article data-lock="app">
        <p>
          <AppIcon className="size-5" />
          <strong>{app.title}</strong>
        </p>
        <article data-lock="second">
          <p>
            <SecondIcon className="size-5" />
            <strong>{second.title}</strong>
          </p>
          <article data-lock="invisible">
            <p>
              <InvisibleIcon className="size-5" />
              <strong>{invisible.title}</strong>
            </p>
          </article>
        </article>
      </article>
    </figure>
  )
}

function EulerIdentity() {
  return (
    <p className="ed-math-eq">
      <i>e</i>
      <sup>
        <i>i</i>π
      </sup>{' '}
      + 1 = 0
    </p>
  )
}

function MediaFiles() {
  return (
    <div className="ed-files">
      {editorMediaFiles.map(({ id, Icon }) => (
        <span key={id} className={`ed-file ed-file-${id}`}>
          <Icon className="size-5" strokeWidth={1.75} />
        </span>
      ))}
    </div>
  )
}

function paneSample(pane: (typeof editor.panes)[number]) {
  if (pane.id === 'math') return <EulerIdentity />
  if (pane.id === 'media') return <MediaFiles />
  return <p>{pane.sample}</p>
}

function EditorFigure() {
  return (
    <figure className="illust illust-editor" aria-hidden="true">
      {editor.panes.map((pane) => (
        <div key={pane.id} className={`ed-pane ed-${pane.id}`}>
          <small>{pane.title}</small>
          {paneSample(pane)}
        </div>
      ))}
    </figure>
  )
}

function ChatFigure() {
  return (
    <figure className="illust illust-chat" aria-hidden="true">
      <div className="chat-row chat-you">How did today actually feel?</div>
      <div className="chat-row chat-ai">
        You kept coming back to the walk after dinner. Want to start there?
      </div>
      <div className="chat-row chat-you">Yes. The light on the river.</div>
      <div className="chat-row chat-ai chat-stream">
        <span />
        <span />
        <span />
      </div>
    </figure>
  )
}

function SearchFigure() {
  return (
    <figure className="illust illust-search" aria-hidden="true">
      <div className="search-query">the kitchen after rain</div>
      <div className="search-hits">
        <span />
        <span />
        <span />
      </div>
    </figure>
  )
}

function PersonaFigure() {
  return (
    <figure className="illust illust-persona" aria-hidden="true">
      <div className="persona-memories">
        {persona.figure.memories.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div className="persona-chat">
        <div className="chat-row chat-ai">{persona.figure.reply}</div>
        <div className="chat-row chat-you">{persona.figure.you}</div>
      </div>
      <p className="persona-write">{persona.figure.write}</p>
    </figure>
  )
}

function MapPhoto({
  x,
  y,
  rotate,
  variant,
  delay,
}: {
  x: number
  y: number
  rotate: number
  variant: 'kitchen' | 'river' | 'trees'
  delay: string
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate})`}>
      <g className="map-pin-bob" style={{ animationDelay: delay }}>
        <rect className="map-photo-frame" x="-26" y="-52" width="52" height="40" rx="5" />
        {variant === 'kitchen' ? (
          <>
            <rect className="map-photo-sky" x="-22" y="-48" width="44" height="18" rx="2" />
            <rect className="map-photo-ground" x="-22" y="-30" width="44" height="14" rx="2" />
            <rect className="map-photo-window" x="-8" y="-44" width="16" height="10" rx="1" />
          </>
        ) : variant === 'river' ? (
          <>
            <rect className="map-photo-sky" x="-22" y="-48" width="44" height="16" rx="2" />
            <path className="map-photo-water" d="M-22 -32 H22 V-18 H-22 Z" />
            <path className="map-photo-wave" d="M-18 -26 Q-8 -30 2 -26 T22 -26" />
          </>
        ) : (
          <>
            <rect className="map-photo-sky" x="-22" y="-48" width="44" height="32" rx="2" />
            <ellipse className="map-photo-tree" cx="-6" cy="-28" rx="8" ry="10" />
            <ellipse className="map-photo-tree" cx="10" cy="-26" rx="7" ry="9" />
            <rect className="map-photo-ground" x="-22" y="-22" width="44" height="6" rx="1" />
          </>
        )}
      </g>
      <path className="map-stem" d="M0 -12 L0 10" />
      <circle className="map-dot" cx="0" cy="12" r="3.5" />
    </g>
  )
}

function LocationsFigure() {
  const cols = 8
  const rows = 4
  const width = 360
  const height = 180
  const tileW = width / cols
  const tileH = height / rows
  const tiles = Array.from({ length: cols * rows }, (_, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    return (
      <rect key={`${col}-${row}`} x={col * tileW} y={row * tileH} width={tileW} height={tileH} />
    )
  })
  return (
    <figure className="illust illust-map" aria-hidden="true">
      <svg className="map-svg" viewBox="0 0 360 180">
        <rect className="map-ocean" width="360" height="180" rx="10" />
        <path className="map-land" d={NATURAL_EARTH_LAND_D} />
        <g className="map-grid">{tiles}</g>
        <MapPhoto x={58} y={58} rotate={-6} variant="kitchen" delay="0s" />
        <MapPhoto x={182} y={52} rotate={4} variant="river" delay="0.35s" />
        <MapPhoto x={286} y={74} rotate={-3} variant="trees" delay="0.7s" />
      </svg>
    </figure>
  )
}

function TransferArrow() {
  return (
    <svg className="transfer-arrow" viewBox="0 0 40 24" aria-hidden="true">
      <path d="M4 12 H28" />
      <path d="M22 6 L32 12 L22 18" />
    </svg>
  )
}

function TransferFigure() {
  return (
    <figure className="illust illust-transfer" aria-hidden="true">
      <div className="transfer-col">
        {transfer.figure.inbound.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <TransferArrow />
      <strong className="transfer-hub">{transfer.figure.hub}</strong>
      <TransferArrow />
      <div className="transfer-col">
        {transfer.figure.outbound.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </figure>
  )
}

function Demo() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [theme, setTheme] = useState<DesignSystem>(DEFAULT_DESIGN_SYSTEM)
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
        <p className="demo-cue">
          {demo.cue}
          <svg className="demo-cue-arrow" viewBox="0 0 64 80" aria-hidden="true">
            <path className="demo-cue-shaft" d="M44 6 C 44 38 32 62 12 76" />
            <path className="demo-cue-head" d="M12 76 L26 75 L18 63 Z" />
          </svg>
        </p>
      </div>
      <div className="demo-stage">
        <div className="demo-stack" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="demo-window">
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
        </div>
      </div>
      <div className="demo-options">
        <p className="options-label">{demo.optionsTitle}</p>
        <div className="option-badges">
          <div className="option-row" role="group" aria-label={demo.tourAria}>
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
                  <Icon className="size-3.5" />
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
          <div className="option-row" role="radiogroup" aria-label={demo.themeAria}>
            {(
              [
                ['clay', demo.themes.clay],
                ['clean', demo.themes.clean],
                ['signature', demo.themes.signature],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={theme === id}
                disabled={status !== 'ready'}
                onClick={() => changeTheme(id)}
              >
                <span className={`theme-dot theme-dot-${id}`} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="option-meta">
          <p className="demo-disclaimer">{demo.disclaimer}</p>
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
    </section>
  )
}

export default function LandingPage() {
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        {nav.skip}
      </a>
      <header className="site-header">
        <a className="wordmark" href="#main" aria-label={nav.homeAria}>
          <HeadFollowLogo alt="" className="wordmark-head" size={36} />
          {nav.wordmark}
        </a>
        <nav aria-label={nav.mainAria}>
          <a href="#demo">{nav.demo}</a>
          <a href="#features">{nav.features}</a>
          <a href="#compare">{nav.compare}</a>
          <details className="doc-menu">
            <summary>{nav.doc}</summary>
            <p>
              {nav.docDisclosure}{' '}
              <a href={githubUrl} target="_blank" rel="noreferrer">
                {nav.docReadme}
              </a>
              .
            </p>
          </details>
        </nav>
        <div className="header-actions">
          <a className="github-link" href={githubUrl} target="_blank" rel="noreferrer">
            <GitBranch className="size-4.5" />
            <span>{nav.github}</span>
            <ArrowUpRight className="size-3.5" />
          </a>
          <DownloadLink className="download" label={nav.download} ariaLabel={nav.downloadAria} />
        </div>
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
              <DownloadLink
                className="download download-hero"
                label={hero.download}
                ariaLabel={hero.downloadAria}
              />
              <a className="button" href="#demo">
                {hero.tryDemo} <ArrowDown className="size-4" />
              </a>
            </div>
            <p className="availability">
              <Laptop className="size-4" />
              <span>{hero.availability}</span>
            </p>
          </div>
          <div className="hero-portrait">
            <div className="mascot-halo">
              <HeadFollowLogo alt={hero.mascotAlt} className="hero-head" size={280} />
            </div>
            <p>
              {hero.portraitLead}
              <br />
              <span>{hero.portraitAccent}</span>
            </p>
          </div>
        </section>
        <Demo />
        <section className="split" id="features">
          <div>
            <h2>{encrypt.title}</h2>
            <p>{encrypt.body}</p>
            <ul>
              {encrypt.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
          <EncryptFigure />
        </section>
        <section className="split split-flip" id="locks">
          <LocksFigure />
          <div>
            <h2>{locks.title}</h2>
            <p>{locks.body}</p>
            <ul className="lock-list">
              {locks.items.map((item) => {
                const Icon = lockIcons[item.id]
                return (
                  <li key={item.id}>
                    <Icon className="size-4" />
                    <div>
                      <h3>{item.title}</h3>
                      <p>{item.text}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </section>
        <section className="split" id="editor">
          <div>
            <h2>{editor.title}</h2>
            <p>{editor.body}</p>
          </div>
          <EditorFigure />
        </section>
        <section className="ai-section" id="ai">
          <div className="ai-intro">
            <Sparkles className="size-7" />
            <div>
              <h2>{ai.title}</h2>
              <p>{ai.body}</p>
              <p className="ai-notice">{ai.notice}</p>
            </div>
          </div>
          <div className="ai-grid">
            {ai.items.map((item) => {
              const Icon = aiIcons[item.id]
              return (
                <article key={item.id} data-ai={item.id}>
                  <span className="ai-icon">
                    <Icon className="size-5" />
                  </span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              )
            })}
          </div>
        </section>
        <section className="split split-flip" id="chat">
          <ChatFigure />
          <div>
            <h2>{chat.title}</h2>
            <p>{chat.body}</p>
            <ul>
              {chat.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </section>
        <section className="split" id="persona">
          <div>
            <h2>{persona.title}</h2>
            <p>{persona.body}</p>
            <ul>
              {persona.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
          <PersonaFigure />
        </section>
        <section className="split" id="search">
          <div>
            <h2>{search.title}</h2>
            <p>{search.body}</p>
            <ul>
              {search.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
          <SearchFigure />
        </section>
        <section className="split split-flip" id="locations">
          <LocationsFigure />
          <div>
            <h2>{locations.title}</h2>
            <p>{locations.body}</p>
            <ul>
              {locations.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </section>
        <section className="split" id="import-export">
          <div>
            <h2>{transfer.title}</h2>
            <p>{transfer.body}</p>
            <ul>
              {transfer.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
          <TransferFigure />
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
                  <th scope="col">
                    <span className="sr-only">Compared</span>
                  </th>
                  {comparison.products.map((product) => (
                    <th key={product.name} scope="col">
                      {product.name === 'Memlore' ? (
                        <span className="compare-brand">
                          <img src="./head-rotate/default.png" alt="" width="28" height="28" />
                          {product.name}
                        </span>
                      ) : (
                        product.name
                      )}
                      {product.badge ? <small>{product.badge}</small> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.label}</th>
                    {comparison.products.map((product) => {
                      const mark = row.marks[product.name]
                      const label =
                        mark === 'yes'
                          ? comparison.yes
                          : mark === 'no'
                            ? comparison.no
                            : comparison.partial
                      return (
                        <td
                          key={product.name}
                          className={product.name === 'Memlore' ? 'memlore-cell' : undefined}
                        >
                          <MarkIcon mark={mark} label={`${product.name}: ${label}`} />
                        </td>
                      )
                    })}
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
          <HeadFollowLogo alt="" className="footer-head" size={72} />
          <h2>
            {footer.titleLead}
            <br />
            {footer.titleAccent}
          </h2>
          <div className="button-row footer-actions">
            <DownloadLink
              className="download download-hero"
              label={footer.download}
              ariaLabel={footer.downloadAria}
            />
            <a className="button" href="#demo">
              {footer.tryDemo}
            </a>
          </div>
        </div>
        <div className="footer-bottom">
          <a className="wordmark" href="#main">
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
