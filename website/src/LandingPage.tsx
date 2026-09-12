import { useEffect, useRef, useState } from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CalendarClock,
  Check,
  Code2,
  Cpu,
  Download,
  EyeOff,
  FileText,
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
  Menu,
  MessageCircle,
  MessageSquareQuote,
  Mic,
  Monitor,
  PenLine,
  Plus,
  ScanSearch,
  Shield,
  Smartphone,
  Sparkles,
  UserRound,
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
  type ComparisonLevel,
  type ComparisonMark,
  type ComparisonProductName,
} from './content'
import { DEFAULT_DESIGN_SYSTEM, isTrustedIframeEvent, sendDemoCommand } from './demoBridge'
import type { DesignSystem } from './demoBridge'
import HeadFollowLogo, { preloadHeadSprites } from './HeadFollowLogo'
import { logoSrc } from './logoDirection'
import { NATURAL_EARTH_LAND_D } from './naturalEarthLand'

const aiIcons = {
  titles: Heading,
  summaries: Highlighter,
  deeper: Lightbulb,
  continue: PenLine,
  chat: MessageCircle,
  ask: MessageSquareQuote,
  memories: UserRound,
  reviews: BarChart3,
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

const COMPACT_QUERY = '(max-width: 68rem)'

function useWideViewport() {
  const [wide, setWide] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return !window.matchMedia(COMPACT_QUERY).matches
  })
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY)
    const update = () => setWide(!mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return wide
}

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
      data-variant="primary"
    >
      <span className="download-glow" aria-hidden="true">
        <span className="download-glow-h" />
        <span className="download-glow-v" />
      </span>
      <Download className="size-4" />
      <span className="download-label">{label}</span>
    </a>
  )
}

function GitHubMark() {
  return (
    <svg className="github-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.24 9.24 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
      />
    </svg>
  )
}

function GitHubLink({ className }: { className: string }) {
  return (
    <a className={`github-link ${className}`} href={githubUrl} target="_blank" rel="noreferrer">
      <GitHubMark />
      <span className="github-label">{nav.github}</span>
    </a>
  )
}

function SiteHeader({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const docMenuRef = useRef<HTMLDetailsElement>(null)
  if (wide && open) setOpen(false)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menu = docMenuRef.current
      if (!menu?.open) return
      if (event.target instanceof Node && menu.contains(event.target)) return
      menu.open = false
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      toggleRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const main = document.getElementById('main')
    const footer = document.querySelector('footer')
    main?.setAttribute('inert', '')
    footer?.setAttribute('inert', '')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      main?.removeAttribute('inert')
      footer?.removeAttribute('inert')
    }
  }, [open])
  const close = () => setOpen(false)
  return (
    <>
      {open ? <div className="nav-backdrop" aria-hidden="true" onClick={close} /> : null}
      <header className="site-header" data-nav-open={open ? 'true' : undefined}>
        <a
          className="wordmark"
          href="#main"
          aria-label={nav.homeAria}
          onClick={() => {
            if (!open) return
            setOpen(false)
            document.getElementById('main')?.removeAttribute('inert')
            document.querySelector('footer')?.removeAttribute('inert')
          }}
        >
          <HeadFollowLogo alt="" className="wordmark-head" size={36} />
          {nav.wordmark}
        </a>
        <nav
          id="site-nav"
          aria-label={nav.mainAria}
          onClick={(event) => {
            const target = event.target
            if (target instanceof Element && target.closest('a')) close()
          }}
        >
          <a href="#demo">{nav.demo}</a>
          <a href="#features">{nav.features}</a>
          <a href="#compare">{nav.compare}</a>
          <details ref={docMenuRef} className="doc-menu">
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
          <GitHubLink className="header-github" />
          <DownloadLink className="download" label={nav.download} ariaLabel={nav.downloadAria} />
          <button
            ref={toggleRef}
            type="button"
            className="nav-toggle"
            aria-expanded={open}
            aria-controls="site-nav"
            aria-label={open ? nav.closeMenu : nav.menu}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <X className="size-5" aria-hidden="true" />
            ) : (
              <Menu className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </header>
    </>
  )
}

function markLabel(mark: ComparisonMark) {
  if (typeof mark === 'number') return comparison.levels[mark - 1]
  if (mark === 'yes') return comparison.yes
  if (mark === 'no') return comparison.no
  if (mark === 'soon') return comparison.soon
  return comparison.partial
}

function LevelDial({ mark, product }: { mark: ComparisonLevel; product: ComparisonProductName }) {
  const explanation = comparison.levels[mark - 1]
  const label = `${product}: ${explanation}`
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })
  const hover = useHover(context, { move: false, delay: { open: 80, close: 0 } })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  return (
    <>
      <span
        ref={refs.setReference}
        className="mark mark-level"
        data-level={mark}
        role="img"
        {...getReferenceProps()}
        aria-label={label}
        tabIndex={0}
      >
        <span className="level-dial" aria-hidden="true" />
      </span>
      {open ? (
        <FloatingPortal>
          <span
            ref={refs.setFloating}
            className="mark-tip"
            style={floatingStyles}
            {...getFloatingProps()}
          >
            {explanation}
          </span>
        </FloatingPortal>
      ) : null}
    </>
  )
}

function MarkIcon({ mark, product }: { mark: ComparisonMark; product: ComparisonProductName }) {
  const label = `${product}: ${markLabel(mark)}`
  if (typeof mark === 'number') {
    return <LevelDial mark={mark} product={product} />
  }
  if (mark === 'yes') {
    return (
      <span className="mark mark-yes" aria-label={label}>
        <Check className="size-3" aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'no') {
    return (
      <span className="mark mark-no" aria-label={label}>
        <X className="size-3" aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'soon') {
    return (
      <span className="mark mark-soon" aria-label={label}>
        {comparison.soon}
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
            <FileText className="size-10" />
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
            <Shield className="size-10" />
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

function SlashPreview() {
  return (
    <div className="ed-slash-menu">
      <span className="ed-slash-prompt">/</span>
      <div className="ed-slash-list">
        {editor.slashItems.map((item) => (
          <div key={item.label} className="ed-slash-item">
            <span>{item.label}</span>
            {item.hint ? <span className="ed-slash-hint">{item.hint}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function MarkdownPreview() {
  return <pre className="ed-md">{editor.markdownSample}</pre>
}

function PluginsPreview({ sample }: { sample: string }) {
  return (
    <div className="ed-plugins-row">
      <Plus className="size-5" strokeWidth={1.75} />
      <p>{sample}</p>
    </div>
  )
}

function paneSample(pane: (typeof editor.panes)[number]) {
  if (pane.id === 'math') return <EulerIdentity />
  if (pane.id === 'media') return <MediaFiles />
  if (pane.id === 'slash') return <SlashPreview />
  if (pane.id === 'markdown') return <MarkdownPreview />
  if (pane.id === 'plugins') return <PluginsPreview sample={pane.sample} />
  return <p>{pane.sample}</p>
}

function EditorFigure() {
  return (
    <figure className="illust illust-editor" aria-hidden="true">
      {editor.panes.map((pane) => (
        <div key={pane.id} className={`ed-pane ed-${pane.id}`}>
          <small>
            {pane.title}
            {'tag' in pane ? <span className="ed-tag">{pane.tag}</span> : null}
          </small>
          {paneSample(pane)}
        </div>
      ))}
    </figure>
  )
}

function ChatFigure() {
  return (
    <figure className="illust illust-chat" aria-hidden="true">
      <div className="chat-window">
        <div className="chat-chrome">
          <strong>
            <MessageCircle className="size-4" />
            {chat.figure.title}
          </strong>
          <span className="chat-save">
            <Sparkles className="size-3.5" />
            {chat.figure.save}
          </span>
        </div>
        <div className="chat-thread">
          {chat.figure.messages.map((message) => (
            <div
              key={message.text}
              className={message.from === 'you' ? 'chat-row chat-you' : 'chat-row chat-ai'}
            >
              {message.text}
            </div>
          ))}
        </div>
        <div className="chat-composer">
          <span>{chat.figure.placeholder}</span>
          <span className="chat-send">
            <ArrowUp className="size-3.5" />
          </span>
        </div>
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
      <p className="persona-caption">{persona.figure.fromEntries}</p>
      <div className="persona-memories">
        {persona.figure.memories.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div className="chat-row chat-ai">{persona.figure.reply}</div>
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

function DemoPlaceholder() {
  return (
    <div className="demo-placeholder">
      <figure className="demo-placeholder-stage">
        <HeadFollowLogo alt="" className="demo-placeholder-head" size={112} />
        <p className="demo-placeholder-title">{demo.placeholderTitle}</p>
        <p>{demo.placeholderBody}</p>
      </figure>
    </div>
  )
}

function DemoLive() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [theme, setTheme] = useState<DesignSystem>(DEFAULT_DESIGN_SYSTEM)
  const themeRef = useRef(theme)
  useEffect(() => {
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
    <div className="demo-stage">
      <div className="demo-stack" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="demo-window">
        <div className="demo-chrome">
          <p className="demo-chrome-label" id="demo-appearance-label">
            {demo.themeAria}
            <ArrowRight className="size-3" aria-hidden="true" />
          </p>
          <div className="option-row" role="radiogroup" aria-labelledby="demo-appearance-label">
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
          <a className="demo-chrome-open" href="./demo.html" target="_blank" rel="noreferrer">
            <Maximize2 className="size-3" />
            {demo.openSeparately}
          </a>
        </div>
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
                    data-variant="secondary"
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
      <p className="demo-disclaimer">{demo.disclaimer}</p>
    </div>
  )
}

function Demo({ wide }: { wide: boolean }) {
  return (
    <section className="demo-section" id="demo" aria-labelledby="demo-title">
      <div className="section-heading demo-heading">
        <div>
          <h2 id="demo-title">{demo.title}</h2>
          <p>{demo.subtitle}</p>
        </div>
        {wide ? (
          <p className="demo-cue">
            {demo.cue}
            <svg className="demo-cue-arrow" viewBox="0 0 64 80" aria-hidden="true">
              <path className="demo-cue-shaft" d="M44 6 C 44 38 32 62 12 76" />
              <path className="demo-cue-head" d="M12 76 L26 75 L18 63 Z" />
            </svg>
          </p>
        ) : null}
      </div>
      {wide ? <DemoLive /> : <DemoPlaceholder />}
    </section>
  )
}

export default function LandingPage() {
  const wide = useWideViewport()
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        {nav.skip}
      </a>
      <SiteHeader wide={wide} />
      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <p className="hero-badges">
              <span className="hero-badge">
                <Code2 className="size-3.5" />
                {hero.badgeOpenSource}
              </span>
              <span className="hero-badge" data-tone="free">
                <Heart className="size-3.5" />
                {hero.badgeFree}
              </span>
            </p>
            <h1>
              {hero.titleLead}
              <br />
              <span>{hero.titleAccent}</span>
            </h1>
            <p className="hero-description">
              <strong>{hero.descriptionLead}</strong> {hero.description}
            </p>
            <div className="button-row">
              <DownloadLink
                className="download download-hero"
                label={hero.download}
                ariaLabel={hero.downloadAria}
              />
              <a className="button" href="#demo" data-variant="secondary">
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
              {wide ? (
                <HeadFollowLogo alt={hero.mascotAlt} className="hero-head" size={280} />
              ) : (
                <span className="hero-head">
                  <img
                    src={logoSrc('straight')}
                    width={280}
                    height={280}
                    alt={hero.mascotAltStill}
                  />
                </span>
              )}
            </div>
            <p>
              {hero.portraitLead}
              <br />
              <span>{hero.portraitAccent}</span>
            </p>
          </div>
        </section>
        <Demo wide={wide} />
        <section className="split" id="features">
          <div>
            <h2>{encrypt.title}</h2>
            <p>{encrypt.body}</p>
          </div>
          <EncryptFigure />
        </section>
        <section className="split split-flip" id="locks">
          <LocksFigure />
          <div className="locks-copy">
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
                  <span className="ai-icon" aria-hidden="true">
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
          </div>
        </section>
        <section className="split" id="persona">
          <div>
            <h2>{persona.title}</h2>
            <p>{persona.body}</p>
          </div>
          <PersonaFigure />
        </section>
        <section className="split" id="search">
          <div>
            <h2>{search.title}</h2>
            <p>{search.body}</p>
          </div>
          <SearchFigure />
        </section>
        <section className="split split-flip" id="locations">
          <LocationsFigure />
          <div>
            <h2>{locations.title}</h2>
            <p>{locations.body}</p>
          </div>
        </section>
        <section className="split" id="import-export">
          <div>
            <h2>{transfer.title}</h2>
            <p>{transfer.body}</p>
          </div>
          <TransferFigure />
        </section>
        <section className="open-section" id="open-source">
          <div className="open-symbol" aria-hidden="true">
            <Code2 className="size-16" strokeWidth={1} />
            <span>{openSource.symbol}</span>
          </div>
          <div>
            <h2>{openSource.title}</h2>
            <p>{openSource.body}</p>
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
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <strong>{row.label}</strong>
                      {row.description ? <small>{row.description}</small> : null}
                    </th>
                    {comparison.products.map((product) => (
                      <td
                        key={product.name}
                        className={product.name === 'Memlore' ? 'memlore-cell' : undefined}
                      >
                        <MarkIcon mark={row.marks[product.name]} product={product.name} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="comparison-cards">
            {comparison.products.map((product) => (
              <article
                key={product.name}
                className={product.name === 'Memlore' ? 'compare-card-memlore' : undefined}
              >
                <h3>
                  {product.name === 'Memlore' ? (
                    <span className="compare-brand">
                      <img src="./head-rotate/default.png" alt="" width="28" height="28" />
                      {product.name}
                    </span>
                  ) : (
                    product.name
                  )}
                </h3>
                <ul>
                  {comparison.rows.map((row) => (
                    <li key={row.id}>
                      <span>
                        <strong>{row.label}</strong>
                        {row.description ? <small>{row.description}</small> : null}
                      </span>
                      <MarkIcon mark={row.marks[product.name]} product={product.name} />
                    </li>
                  ))}
                </ul>
              </article>
            ))}
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
            <a className="button" href="#demo" data-variant="secondary">
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
