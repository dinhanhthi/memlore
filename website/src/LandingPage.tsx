import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
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
  ArrowUpRight,
  AtSign,
  BarChart3,
  Blocks,
  BookOpen,
  CalendarClock,
  Check,
  Cloud,
  Columns3,
  Code2,
  Cpu,
  Download,
  EyeOff,
  FileText,
  Hash,
  Heading,
  Heart,
  Highlighter,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  Laptop,
  Layers,
  Lightbulb,
  Lock,
  Maximize2,
  MessageCircle,
  Mic,
  Minus,
  MessageSquareQuote,
  Monitor,
  MoreHorizontal,
  Palette,
  PenLine,
  Play,
  Puzzle,
  RefreshCw,
  ScanSearch,
  ServerOff,
  Sigma,
  Smartphone,
  Sparkles,
  Type,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { latestStableRelease } from './changelog/changelogData'
import {
  aiFeatureRequestUrl,
  downloadUrl,
  editorFeatureRequestUrl,
  githubUrl,
  licenseUrl,
} from './links'
import { DEFAULT_DESIGN_SYSTEM, isTrustedIframeEvent, sendDemoCommand } from './demoBridge'
import type { DesignSystem } from './demoBridge'
import HeadFollowLogo, { preloadHeadSprites } from './HeadFollowLogo'
import { DownloadLink, SiteHeader } from './SiteHeader'
import { useWideViewport } from './useWideViewport'
import { LedgerGap, LedgerRule, SectionIndex } from './Ledger'
import { SiteFooterBar } from './SiteFooterBar'
import { logoSrc } from './logoDirection'
import { NATURAL_EARTH_LAND_D } from './naturalEarthLand'
import demoPoster from './demoPoster.webp'

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
  coming: Puzzle,
  request: ArrowUpRight,
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
type ComparisonProductName = 'Memlore' | 'Day One' | 'Journey' | 'Apple Journal'
type ComparisonLevel = 1 | 2 | 3 | 4
type ComparisonMark = 'yes' | 'no' | 'partial' | 'soon' | ComparisonLevel

type ComparisonProduct = {
  name: ComparisonProductName
  note: string
  sourceUrl?: string
}

type ComparisonRow = {
  id: string
  label: string
  description?: string
  marks: Record<ComparisonProductName, ComparisonMark>
}

const comparisonLevels = ['A few', 'About half', 'Most', 'The full set']

function markLabel(mark: ComparisonMark) {
  if (typeof mark === 'number') return comparisonLevels[mark - 1]
  if (mark === 'yes') return 'Yes'
  if (mark === 'no') return 'No'
  if (mark === 'soon') return 'Soon'
  return 'Varies or not documented'
}

function LevelDial({ mark, product }: { mark: ComparisonLevel; product: ComparisonProductName }) {
  const explanation = comparisonLevels[mark - 1]
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
      <span className="mark mark-yes" role="img" aria-label={label}>
        <Check className="size-4" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'no') {
    return (
      <span className="mark mark-no" role="img" aria-label={label}>
        <X className="size-4" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  if (mark === 'soon') {
    return (
      <span className="mark mark-soon" role="img" aria-label={label}>
        Soon
      </span>
    )
  }
  return (
    <span className="mark mark-partial" role="img" aria-label={label}>
      <Minus className="size-4" strokeWidth={2} aria-hidden="true" />
    </span>
  )
}

/* The two-way dashed arrow shared by the encrypt and sync figures. */
function ExchangeArrow() {
  return (
    <svg className="encrypt-arrow" viewBox="0 0 72 40" aria-hidden="true">
      <path className="encrypt-dash" d="M8 11 H54" />
      <path d="M48 6 L58 11 L48 16" />
      <path className="encrypt-dash" d="M64 29 H18" />
      <path d="M24 24 L14 29 L24 34" />
    </svg>
  )
}

function EncryptArrow({ label, blocked = false }: { label: string; blocked?: boolean }) {
  return (
    <div className="encrypt-link">
      {blocked ? (
        <svg className="encrypt-arrow encrypt-arrow-blocked" viewBox="0 0 72 40" aria-hidden="true">
          <path d="M6 20 H28" />
          <path d="M66 20 H44" />
          <path d="M32 13 L40 27" />
          <path d="M40 13 L32 27" />
        </svg>
      ) : (
        <ExchangeArrow />
      )}
      <small>{label}</small>
    </div>
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
          <small>Your content</small>
        </article>
        <EncryptArrow label="Your password" />
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <span className="encrypt-orbit" />
            <Cloud className="size-8" />
          </div>
          <small>Your cloud</small>
        </article>
        <EncryptArrow label="No access" blocked />
        <article className="encrypt-card encrypt-card-muted">
          <div className="encrypt-card-body">
            <Users className="size-10" />
          </div>
          <small>Others (even us)</small>
        </article>
        <p className="encrypt-unseen">
          <EyeOff className="size-5" />
          Encrypted before it leaves your device
        </p>
      </div>
    </figure>
  )
}

/* Brand marks: Google Drive (official geometry) and iCloud. Fills are brand
   colours on purpose — the rest of the figure paints through the tokens. */
function GoogleDriveMark() {
  return (
    <svg className="sync-logo" viewBox="0 0 87.3 78" aria-hidden="true">
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        fill="#ea4335"
      />
      <path
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  )
}

function ICloudMark() {
  return (
    <svg className="sync-logo sync-logo-cloud" viewBox="0 0 64 40" aria-hidden="true">
      <g fill="#3693f3">
        <circle cx="22" cy="19" r="14" />
        <circle cx="40" cy="15" r="11" />
        <circle cx="50" cy="26" r="10" />
        <rect x="14" y="22" width="40" height="14" rx="7" />
      </g>
    </svg>
  )
}

function MoreCloudsMark() {
  return (
    <span className="sync-logo sync-logo-more" aria-hidden="true">
      <MoreHorizontal className="size-3" />
    </span>
  )
}

// Marks drawn in the cloud card, in order. `more` is the dashed placeholder
// standing in for the cloud services still to come.
// TODO(later): only gdrive and icloud ship today — see docs/LATER.md.
const syncProviders = ['gdrive', 'icloud', 'more'] as const

const syncLogos: Record<(typeof syncProviders)[number], () => ReactElement> = {
  gdrive: GoogleDriveMark,
  icloud: ICloudMark,
  more: MoreCloudsMark,
}

function SyncLink({ icon: Icon, label }: { icon: typeof Lock; label: string }) {
  return (
    <div className="encrypt-link sync-link">
      <Icon className="sync-link-icon size-4" />
      <ExchangeArrow />
      <small>{label}</small>
    </div>
  )
}

/* Borrows the encrypt figure's scene/card/link classes — restyling
   `.encrypt-*` in styles.css reshapes this figure too. */
function SyncFigure() {
  return (
    <figure className="illust illust-encrypt illust-sync" aria-hidden="true">
      <div className="encrypt-scene">
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <Laptop className="size-10" />
          </div>
          <small>This device</small>
        </article>
        <SyncLink icon={Lock} label="Encrypted with your password" />
        <article className="encrypt-card">
          <div className="encrypt-card-body sync-providers">
            {syncProviders.map((provider) => {
              const Mark = syncLogos[provider]
              return <Mark key={provider} />
            })}
          </div>
          <small>Your own cloud</small>
        </article>
        <SyncLink icon={RefreshCw} label="Synced" />
        <article className="encrypt-card">
          <div className="encrypt-card-body">
            <Smartphone className="size-10" />
          </div>
          <small>Your other devices</small>
        </article>
        <p className="encrypt-unseen">
          <ServerOff className="size-5" />
          No Memlore server in between
        </p>
      </div>
    </figure>
  )
}

const lockItems = [
  {
    id: 'app' as const,
    title: 'App lock',
    text: 'The journal only opens with the password or Touch ID. This lock is required and protects it from unauthorized access.',
  },
  {
    id: 'second' as const,
    title: 'Second lock',
    text: 'To keep some entries private, add a second lock. Others with app access will know private entries exist, but cannot open them.',
  },
  {
    id: 'invisible' as const,
    title: 'Invisible vault',
    text: 'If you need entries to stay completely invisible and private, even from people who can unlock the app, they won’t know these entries exist.',
  },
]

function LocksFigure() {
  const [app, second, invisible] = lockItems
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
        <div className="lock-peers">
          <article data-lock="second">
            <p>
              <SecondIcon className="size-5" />
              <strong>{second.title}</strong>
            </p>
          </article>
          <article data-lock="invisible">
            <p>
              <InvisibleIcon className="size-5" />
              <strong>{invisible.title}</strong>
            </p>
          </article>
        </div>
      </article>
    </figure>
  )
}

const editorPanes = [
  { id: 'text' as const, title: 'Words', Icon: Type },
  { id: 'math' as const, title: 'Math', Icon: Sigma },
  { id: 'code' as const, title: 'Code', Icon: Code2 },
  { id: 'media' as const, title: 'Media', Icon: ImageIcon },
  { id: 'slash' as const, title: 'Slash command', mark: '/' },
  { id: 'mention' as const, title: 'Mentions', Icon: AtSign },
  { id: 'markdown' as const, title: 'Markdown', Icon: Hash },
  { id: 'plugins' as const, title: 'More plugins', Icon: Puzzle },
  {
    id: 'request' as const,
    title: 'Need more?',
    Icon: ArrowUpRight,
    href: editorFeatureRequestUrl,
  },
]

function EditorFigure() {
  return (
    <figure className="illust illust-editor">
      {editorPanes.map((pane) => {
        const inner = (
          <>
            {'mark' in pane ? (
              <span className="ed-slash-mark">{pane.mark}</span>
            ) : (
              <pane.Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{pane.title}</span>
          </>
        )
        const className = `ed-card ed-${pane.id}`
        if ('href' in pane) {
          return (
            <a
              key={pane.id}
              className={className}
              href={pane.href}
              target="_blank"
              rel="noreferrer"
            >
              {inner}
            </a>
          )
        }
        return (
          <div key={pane.id} className={className} aria-hidden="true">
            {inner}
          </div>
        )
      })}
      <div className="ed-empty" aria-hidden="true" />
    </figure>
  )
}

const emotionOptions = [
  { key: 'bad' as const, emoji: '\u{1F61E}', label: 'Not good' },
  { key: 'neutral' as const, emoji: '\u{1F610}', label: 'So-so' },
  { key: 'good' as const, emoji: '\u{1F60A}', label: 'Good' },
]

function EmotionsFigure() {
  return (
    <figure className="illust illust-emotions" aria-hidden="true">
      <p className="emotion-prompt">How are you feeling?</p>
      <div className="emotion-options">
        {emotionOptions.map((option) => (
          <span
            key={option.key}
            data-emotion={option.key}
            data-selected={option.key === 'good' ? '' : undefined}
          >
            <span>{option.emoji}</span>
            <span className="emotion-label">{option.label}</span>
          </span>
        ))}
      </div>
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
  variant: 'image' | 'video' | 'audio'
  delay: string
}) {
  return (
    <g data-map-pin={variant} transform={`translate(${x} ${y}) rotate(${rotate})`}>
      <g className="map-pin-bob" style={{ animationDelay: delay }}>
        <rect className="map-photo-frame" x="-26" y="-52" width="52" height="40" rx="5" />
        {/* Lucide glyphs drawn on their native 24x24 grid, then centred in the frame. */}
        <g className="map-icon" transform="translate(0 -32) scale(0.92) translate(-12 -12)">
          {variant === 'image' ? (
            <>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </>
          ) : variant === 'video' ? (
            <>
              <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </>
          ) : (
            <>
              <path d="M2 10v3" />
              <path d="M6 6v11" />
              <path d="M10 3v18" />
              <path d="M14 8v7" />
              <path d="M18 5v13" />
              <path d="M22 10v3" />
            </>
          )}
        </g>
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
      <svg className="map-svg" viewBox="0 0 360 180" preserveAspectRatio="none">
        <rect className="map-ocean" width="360" height="180" />
        <path className="map-land" d={NATURAL_EARTH_LAND_D} />
        <g className="map-grid">{tiles}</g>
        <MapPhoto x={128} y={87} rotate={-6} variant="image" delay="0s" />
        <MapPhoto x={182} y={52} rotate={4} variant="video" delay="0.35s" />
        <MapPhoto x={286} y={74} rotate={-3} variant="audio" delay="0.7s" />
      </svg>
    </figure>
  )
}

const transferInbound = ['Day One', 'Journey', 'Apple Journal', 'Markdown', 'Plain text']
const transferOutbound = ['Backup', 'Markdown', 'Plain text']

function transferFlowPaths(root: HTMLElement): { w: number; h: number; paths: string[] } {
  const w = root.clientWidth
  const h = root.clientHeight
  const origin = root.getBoundingClientRect()
  const hub = root.querySelector('.transfer-hub')
  if (!(hub instanceof HTMLElement) || w === 0 || h === 0) return { w, h, paths: [] }
  const hubBox = hub.getBoundingClientRect()
  const hubLeft = hubBox.left - origin.left
  const hubRight = hubBox.right - origin.left
  const hubY = hubBox.top - origin.top + hubBox.height / 2
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const gap = x2 - x1
    const c1 = x1 + Math.max(28, gap * 0.72)
    const c2 = x2 - Math.max(14, gap * 0.22)
    return `M${x1.toFixed(1)},${y1.toFixed(1)} C${c1.toFixed(1)},${y1.toFixed(1)} ${c2.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }
  const inbound = [...root.querySelectorAll('.transfer-in span')].map((el) => {
    const box = el.getBoundingClientRect()
    return curve(box.right - origin.left, box.top - origin.top + box.height / 2, hubLeft, hubY)
  })
  const outbound = [...root.querySelectorAll('.transfer-out span')].map((el) => {
    const box = el.getBoundingClientRect()
    return curve(hubRight, hubY, box.left - origin.left, box.top - origin.top + box.height / 2)
  })
  return { w, h, paths: [...inbound, ...outbound] }
}

function TransferFigure() {
  const rootRef = useRef<HTMLElement>(null)
  const [flow, setFlow] = useState({ w: 0, h: 0, paths: [] as string[] })

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const update = () => setFlow(transferFlowPaths(root))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  return (
    <figure ref={rootRef} className="illust illust-transfer" aria-hidden="true">
      {flow.w > 0 ? (
        <svg
          className="transfer-flow"
          viewBox={`0 0 ${flow.w} ${flow.h}`}
          width={flow.w}
          height={flow.h}
        >
          {flow.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ) : null}
      <div className="transfer-col transfer-in">
        {transferInbound.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <strong className="transfer-hub">Memlore</strong>
      <div className="transfer-col transfer-out">
        {transferOutbound.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </figure>
  )
}

const lookCards = [
  { id: 'clay', skin: 'Clay', layout: 'left' as const, title: 'Tuesday', line: 'A quiet morning' },
  {
    id: 'signature',
    skin: 'Signature',
    layout: 'right' as const,
    title: 'Monday',
    line: 'After dark',
  },
  {
    id: 'clean',
    skin: 'Clean',
    layout: 'center' as const,
    title: 'Notes',
    line: 'Plain and clear',
  },
  { id: 'lumen', skin: 'Lumen', layout: 'left' as const, title: 'Night', line: 'Foundry dark' },
  {
    id: 'clay-dark',
    skin: 'Clay',
    layout: 'right' as const,
    title: 'Evening',
    line: 'Warm paper',
  },
]

function LooksFigure() {
  return (
    <figure className="illust illust-looks" aria-hidden="true">
      {lookCards.map((card) => (
        <article key={card.id} className="look-card" data-look={card.id} data-layout={card.layout}>
          <header>
            <span className="look-dots">
              <span />
              <span />
              <span />
            </span>
            <strong>{card.skin}</strong>
          </header>
          <div className="look-body">
            <aside className="look-nav">
              <span />
              <span />
              <span />
            </aside>
            <aside className="look-list">
              <span />
              <span />
              <span />
            </aside>
            <section className="look-page">
              <p>{card.title}</p>
              <small>{card.line}</small>
              <span className="look-rule" />
              <span className="look-rule" />
              <span className="look-rule" />
            </section>
          </div>
        </article>
      ))}
      <article className="look-card" data-look="editor">
        <p>A lasting story.</p>
        <small>The type you write in.</small>
        <span>Google Font · contrast</span>
      </article>
    </figure>
  )
}

const lookItems = [
  {
    id: 'skins' as const,
    Icon: Layers,
    title: 'Three design systems',
    text: 'Signature, Clean, and Clay. Switch them live in the demo above.',
  },
  {
    id: 'knobs' as const,
    Icon: Palette,
    title: 'Then the knobs',
    text: 'Accent color, corner radius, light or dark, and the dark surface — Deep, Soft, or Lumen.',
  },
  {
    id: 'layout' as const,
    Icon: Columns3,
    title: 'Panel layout',
    text: 'Sidebar and list on the left, the right, or with the page in the middle.',
  },
  {
    id: 'type' as const,
    Icon: Type,
    title: 'Type',
    text: 'The app typeface follows the skin. The editor has its own font — a built-in face or a custom Google Font, plus size and contrast.',
  },
]

const talkItems = [
  {
    id: 'daily' as const,
    Icon: MessageCircle,
    title: 'Daily Chat',
    text: 'Type inside Memlore. When you’re ready, save the thread as an entry.',
  },
  {
    id: 'voice' as const,
    Icon: Mic,
    title: 'Voice mode',
    text: 'Speak the day instead of typing.',
  },
  {
    id: 'mcp' as const,
    Icon: Blocks,
    title: 'MCP',
    text: 'Chat in ChatGPT, Claude, Gemini, Ollama, or another AI you already use.',
  },
]

function TalkFigure() {
  return (
    <figure className="illust illust-talk" aria-hidden="true">
      <article className="talk-way" data-talk="daily">
        <p>
          <MessageCircle className="size-4" />
          <strong>Daily Chat</strong>
        </p>
        <div className="talk-bubbles">
          <span data-who="you">The walk helped.</span>
          <span data-who="ai">What stayed with you?</span>
          <span data-who="you">How quiet the street was.</span>
          <span data-who="ai">I’ll keep that for the page.</span>
        </div>
      </article>
      <article className="talk-way" data-talk="voice">
        <p>
          <Mic className="size-4" />
          <strong>Voice</strong>
        </p>
        <div className="talk-voice">
          <div className="talk-wave">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="talk-transcript">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </article>
      <article className="talk-way" data-talk="mcp">
        <p>
          <Blocks className="size-4" />
          <strong>MCP</strong>
        </p>
        <div className="talk-mcp">
          <div className="talk-clients">
            <span>ChatGPT</span>
            <span>Claude</span>
            <span>Gemini</span>
            <span>Ollama</span>
            <span>More</span>
          </div>
          <div className="talk-tools">
            <span className="talk-tool">
              <ScanSearch className="size-3.5" />
              Search entries
            </span>
            <span className="talk-tool">
              <BookOpen className="size-3.5" />
              Read a page
            </span>
            <span className="talk-tool">
              <PenLine className="size-3.5" />
              Append today
            </span>
          </div>
        </div>
      </article>
      <p className="talk-into">
        <FileText className="size-4" />
        Then save it as an entry
      </p>
    </figure>
  )
}

function PersonaFigure() {
  return (
    <figure className="illust illust-persona" aria-hidden="true">
      <svg
        className="persona-scene"
        viewBox="0 0 24 32"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g className="persona-echo" strokeWidth={1} strokeDasharray="3 2.4">
          <path d="M22 29 V20 c0-3.37-2-6.5-4-8 a5 5 0 0 0-.45-8.3" />
        </g>
        <g className="persona-self">
          <circle cx="10" cy="8" r="5" />
          <path d="M18 30 V21 a8 8 0 0 0-16 0 V30" />
        </g>
      </svg>
    </figure>
  )
}

const personaItems = [
  {
    id: 'style' as const,
    Icon: PenLine,
    title: 'Your writing style',
    text: 'Sampled from the pages you already keep.',
  },
  {
    id: 'memories' as const,
    Icon: UserRound,
    title: 'Your memories',
    text: 'The people, places, and facts Memlore has learned.',
  },
  {
    id: 'words' as const,
    Icon: MessageCircle,
    title: 'Your own words',
    text: 'A few answers about how you want to sound — and who you are.',
  },
]

const pluginMarks = [
  { id: 'plugins', Icon: Puzzle },
  { id: 'tables', Icon: Columns3 },
  { id: 'charts', Icon: BarChart3 },
  { id: 'highlights', Icon: Highlighter },
  { id: 'calendar', Icon: CalendarClock },
  { id: 'audio', Icon: Mic },
]

function PluginsFigure() {
  return (
    <figure className="illust illust-plugins" aria-hidden="true">
      {pluginMarks.map((mark) => (
        <mark.Icon key={mark.id} className="size-8" strokeWidth={1.5} />
      ))}
    </figure>
  )
}

function DemoPlaceholder() {
  return (
    <div className="demo-placeholder">
      <figure className="demo-placeholder-stage">
        <HeadFollowLogo alt="" className="demo-placeholder-head" size={112} />
        <p className="demo-placeholder-title">This preview needs a wider window.</p>
        <p>
          The live journal is a desktop app, so it cannot run here. When the iOS and Android apps
          arrive, their view will take this place.
        </p>
      </figure>
      <LedgerRule />
    </div>
  )
}

function DemoLive() {
  const frame = useRef<HTMLIFrameElement>(null)
  // The demo is the full app (~1.5 MB gzipped, same origin, same main thread). Mount it
  // only on click so it never counts against the landing page's blocking time.
  const [started, setStarted] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)
  // The start button unmounts on click; hand focus to the status region so
  // keyboard and screen-reader users are not dropped on <body>.
  useEffect(() => {
    if (started) statusRef.current?.focus()
  }, [started])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [theme, setTheme] = useState<DesignSystem>(DEFAULT_DESIGN_SYSTEM)
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
  }, [theme])
  useEffect(() => {
    if (!started) return
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
  }, [attempt, started])
  const changeTheme = (designSystem: DesignSystem) => {
    setTheme(designSystem)
    sendDemoCommand(frame.current, { command: 'theme', designSystem })
  }
  return (
    <div className="demo-stage" data-upright={status === 'ready' ? '' : undefined}>
      <div className="demo-stack" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="demo-window">
        <div className="demo-chrome">
          <p className="demo-chrome-label" id="demo-appearance-label">
            Choose appearance
            <ArrowRight className="size-3" aria-hidden="true" />
          </p>
          <div className="option-row" role="radiogroup" aria-labelledby="demo-appearance-label">
            {(
              [
                ['clay', 'Clay'],
                ['clean', 'Clean'],
                ['signature', 'Signature'],
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
            Open separately
          </a>
        </div>
        <div className="demo-viewport">
          {started && (
            <iframe
              ref={frame}
              key={attempt}
              src="./demo.html"
              title="Interactive Memlore demo with fictional journal entries"
              onError={() => setStatus('error')}
            />
          )}
          {status !== 'ready' && (
            <div className="demo-status" role="status" ref={statusRef} tabIndex={-1}>
              <img
                className="demo-poster"
                src={demoPoster}
                alt={
                  started ? '' : 'Blurred preview of the Memlore journal with a sample entry open'
                }
                width={1280}
                height={700}
                decoding="async"
              />
              {!started && (
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  onClick={() => setStarted(true)}
                >
                  <Play className="size-4" /> Start the demo
                </button>
              )}
              {started && (
                <>
                  {status === 'loading' && <span className="demo-progress" aria-hidden="true" />}
                  <BookOpen className="size-8" />
                  <h3>
                    {status === 'loading'
                      ? 'Opening your sample journal…'
                      : 'The demo is taking a little longer.'}
                  </h3>
                  <p>
                    {status === 'loading'
                      ? 'There are a few memories to unpack.'
                      : 'Try loading it again, or open the demo in its own tab.'}
                  </p>
                </>
              )}
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
                    Try again
                  </button>
                  <a className="text-link" href="./demo.html" target="_blank" rel="noreferrer">
                    Open demo <ArrowUpRight className="size-4" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <LedgerRule />
      <p className="demo-disclaimer">Sample data. Writing, locks, sync, and AI are simulated.</p>
    </div>
  )
}

function Demo({ wide }: { wide: boolean }) {
  return (
    <section className="demo-section" id="demo" aria-labelledby="demo-title">
      <div className="section-heading demo-heading">
        <div>
          <h2 id="demo-title">Get a feel for it.</h2>
          <p>A mockup of the Memlore app with fake data.</p>
        </div>
        {wide ? (
          <p className="demo-cue">
            Click around. It works like the real app.
            <svg className="demo-cue-arrow" viewBox="0 0 64 72" aria-hidden="true">
              <path
                className="demo-cue-shaft"
                d="M38.2 6 C38.5 7.2 39.7 10.7 39.9 13.1 C40 15.5 39.8 18.2 39.2 20.5 C38.5 22.9 37.4 25.4 36.1 27.4 C34.7 29.4 32.9 31.2 31 32.5 C29.1 33.9 26.8 34.9 24.7 35.3 C22.7 35.8 20.4 35.8 18.5 35.4 C16.5 35 14.7 34.1 13.3 32.9 C11.9 31.8 10.8 30.1 10.2 28.5 C9.7 26.9 9.6 24.9 10 23.2 C10.4 21.5 11.4 19.7 12.8 18.3 C14.1 16.9 16.1 15.6 18.2 15 C20.3 14.3 22.9 14 25.4 14.3 C27.9 14.6 30.7 15.4 33.1 16.8 C35.6 18.2 38.1 20.2 40 22.5 C42 24.9 43.7 27.8 44.8 30.9 C45.8 33.9 46.1 37.3 46.4 40.8 C46.7 44.3 46.4 50 46.4 51.8"
              />
              <path className="demo-cue-head" d="M46.4 64.8 L38.6 50.8 L54.3 50.8 Z" />
            </svg>
          </p>
        ) : null}
      </div>
      <LedgerRule />
      {wide ? <DemoLive /> : <DemoPlaceholder />}
    </section>
  )
}

const aiItems = [
  {
    id: 'titles' as const,
    title: 'Smart titles',
    text: 'A short title suggestion from the entry you just wrote.',
  },
  {
    id: 'summaries' as const,
    title: 'Highlights and summaries',
    text: 'A collapsible recap of themes, emotions, and moments, saved with the entry.',
  },
  {
    id: 'deeper' as const,
    title: 'Go Deeper',
    text: 'Three follow-up reflection prompts, inserted as cards under the editor.',
  },
  {
    id: 'continue' as const,
    title: 'Continue & Rewrite',
    text: 'Continue the entry from the footer, or rewrite a selection — in your voice.',
  },
  {
    id: 'chat' as const,
    title: 'Daily Chat',
    text: 'A conversation about the day that can become a journal entry when you save it.',
  },
  {
    id: 'ask' as const,
    title: 'Ask Journal',
    text: 'You can ask about the memories and entries that Memlore has learned.',
  },
  {
    id: 'memories' as const,
    title: 'Memories and Persona',
    text: 'Based on your entries and information you provide, Memlore can build a second you that writes in your voice and style.',
  },
  {
    id: 'reviews' as const,
    title: 'Reviews and Insights',
    text: 'You can use AI to get the stats of what you have written in a given time period.',
  },
  {
    id: 'search' as const,
    title: 'Semantic search',
    text: 'Not just a keyword search, but a meaning-based search, freely expressed in natural language.',
  },
  {
    id: 'emotion' as const,
    title: 'Emotion suggestion',
    text: "If you enable the emotion tracking feature, AI can suggest the emotions you're feeling based on the entries you've written.",
  },
  {
    id: 'time' as const,
    title: 'Time-machine summary',
    text: 'The same calendar date across years, folded into one recap.',
  },
  {
    id: 'image' as const,
    title: 'Image generation',
    text: 'Using AI to generate cover images and inline illustrations for your entries.',
  },
  {
    id: 'coming' as const,
    title: 'More to come',
  },
  {
    id: 'request' as const,
    title: 'Need more?',
    href: aiFeatureRequestUrl,
  },
  {
    id: 'device' as const,
    title: 'On-device paths',
    text: 'Memlore comes with integrated, local AI to ensure your data is always 100% private and never leaves your device.',
  },
]

const comparisonProducts = [
  {
    name: 'Memlore',
    note: 'Still in beta, and macOS-only today. Other platforms are coming, without a date attached.',
  },
  {
    name: 'Day One',
    note: 'A polished journaling home with a long-established ecosystem. Some features need a paid plan. The app is closed source.',
    sourceUrl: 'https://dayoneapp.com/guides/premium-subscription/day-one-pricing-features-guide/',
  },
  {
    name: 'Journey',
    note: 'A journal across mobile, desktop, and the web. Desktop access and many features depend on a paid plan. The app is closed source.',
    sourceUrl:
      'https://support.journey.cloud/en/categories/purchase-payment/articles/journey-license-comparison',
  },
  {
    name: 'Apple Journal',
    note: 'A simple journal for iPhone, iPad, and Mac, kept close to the rest of Apple’s world.',
    sourceUrl: 'https://apps.apple.com/us/app/journal/id6447391597?platform=ipad',
  },
] satisfies ComparisonProduct[]

const comparisonRows = [
  {
    id: 'open-source',
    label: 'Open source',
    description: 'Anyone can read the code that holds the journal.',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'password',
    label: 'Password required before the journal opens',
    description: 'Not a setting you can switch off. Without it the files stay sealed.',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'your-key-only',
    label: 'Held by your password alone',
    description:
      'All four encrypt. Only Memlore asks for no account, keeps no vendor server, and holds no recovery path back into your journal.',
    marks: {
      Memlore: 'yes',
      'Day One': 'partial',
      Journey: 'partial',
      'Apple Journal': 'partial',
    },
  },
  {
    id: 'local-first',
    label: 'Local-first — no vendor journal server',
    description: 'The journal lives on your machine and works with the network off.',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'own-cloud',
    label: 'Sync through a cloud folder you already own',
    description: 'Memlore uses your Google Drive or iCloud Drive. Journey offers Google Drive too.',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'yes', 'Apple Journal': 'partial' },
  },
  {
    id: 'extra-locks',
    label: 'Second lock and invisible vault',
    description: 'Some entries stay shut, and some leave no trace that they exist.',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'no' },
  },
  {
    id: 'optional-ai',
    label: 'How much optional AI you get',
    description:
      'Titles, summaries, Go Deeper, Continue & Rewrite, Daily Chat, Ask Journal, memories, persona, reviews, insights, semantic search, emotion, time-machine, images — local, on-device, or your own key.',
    marks: { Memlore: 4, 'Day One': 2, Journey: 1, 'Apple Journal': 'no' },
  },
  {
    id: 'editor',
    label: 'An editor that holds more than text',
    description: 'Markdown, math, code blocks, slash commands, and media inside the page.',
    marks: { Memlore: 'yes', 'Day One': 'partial', Journey: 'partial', 'Apple Journal': 'no' },
  },
  {
    id: 'appearance',
    label: 'Make it look like yours',
    description:
      'Three design systems, each with color, corners, light or dark, and surface — plus panel layout and a writing font you choose.',
    marks: { Memlore: 'yes', 'Day One': 'partial', Journey: 'partial', 'Apple Journal': 'no' },
  },
  {
    id: 'macos',
    label: 'macOS app',
    marks: { Memlore: 'yes', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
  },
  {
    id: 'ios',
    label: 'iOS app',
    marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'yes' },
  },
  {
    id: 'android',
    label: 'Android app',
    marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'no' },
  },
  {
    id: 'windows',
    label: 'Windows app',
    marks: { Memlore: 'soon', 'Day One': 'yes', Journey: 'yes', 'Apple Journal': 'no' },
  },
  {
    id: 'linux',
    label: 'Linux app',
    marks: { Memlore: 'soon', 'Day One': 'no', Journey: 'yes', 'Apple Journal': 'no' },
  },
  {
    id: 'beta-free',
    label: 'All current features free during beta',
    marks: { Memlore: 'yes', 'Day One': 'no', Journey: 'no', 'Apple Journal': 'partial' },
  },
] satisfies ComparisonRow[]

type PlatformName = 'macOS' | 'Windows & Linux' | 'iOS & Android'

const platformItems = [
  { name: 'macOS' as const, status: 'Download', href: downloadUrl },
  { name: 'Windows & Linux' as const, status: 'Coming soon' },
  { name: 'iOS & Android' as const, status: 'Coming soon' },
] satisfies { name: PlatformName; status: string; href?: string }[]

function formatLedgerDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`))
}

export default function LandingPage() {
  const wide = useWideViewport()
  useEffect(() => {
    preloadHeadSprites()
  }, [])
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader homeHref="#main" />
      <main id="main" className="ledger" tabIndex={-1}>
        <section className="hero">
          <div className="hero-portrait">
            <div className="mascot-halo">
              {wide ? (
                <HeadFollowLogo
                  alt="Memlore’s dog mascot. The head follows your cursor."
                  className="hero-head"
                  size={168}
                />
              ) : (
                <span className="hero-head">
                  <img
                    src={logoSrc('straight')}
                    width={200}
                    height={200}
                    alt="Memlore’s dog mascot."
                  />
                </span>
              )}
            </div>
            <p>
              A place to land.
              <br />
              <span>Even on the ordinary days.</span>
            </p>
          </div>
          <LedgerRule area="r0" />
          <div className="hero-lead" aria-hidden="true" />
          <LedgerRule area="re" accent />
          <p className="hero-eyebrow headline">
            Memlore
            <span aria-hidden="true"> · </span>
            <span className="hero-eyebrow-version">v{latestStableRelease.version}</span>
            <span aria-hidden="true"> · </span>
            <time dateTime={latestStableRelease.date}>
              {formatLedgerDate(latestStableRelease.date)}
            </time>
            <span aria-hidden="true"> · </span>
            Open source
            <span aria-hidden="true"> · </span>
            <span className="hero-eyebrow-free">Free</span>
          </p>
          <LedgerRule area="r1" />
          <h1 className="hero-title">
            A little life.
            <br />
            <span>A lasting story.</span>
          </h1>
          <LedgerRule area="r2" />
          <p className="hero-description">
            <strong>Memlore is a private journal.</strong> For the days you want to remember, and
            the thoughts you need to put somewhere.
          </p>
          <LedgerRule area="r3" />
          <div className="button-row">
            <DownloadLink
              className="download download-hero"
              label="Download for Mac"
              ariaLabel="Download the beta from GitHub"
            />
            <a className="button" href="#demo" data-variant="secondary">
              Try the demo <ArrowDown className="size-4" />
            </a>
          </div>
          <LedgerRule area="r4" />
          <p className="hero-meta">No account · Encrypted on your device · macOS today</p>
        </section>
        <LedgerRule />
        <section className="spec-strip" aria-label="What Memlore is">
          <dl>
            <div className="spec-item">
              <dt>license</dt>
              <dd>AGPLv3</dd>
              <small>
                <a href={licenseUrl} target="_blank" rel="noreferrer">
                  Read the source <ArrowRight className="size-3" />
                </a>
              </small>
            </div>
            <div className="spec-item">
              <dt>version</dt>
              <dd>v{latestStableRelease.version}</dd>
              <small>
                <time dateTime={latestStableRelease.date}>
                  {formatLedgerDate(latestStableRelease.date)}
                </time>
              </small>
            </div>
            <div className="spec-item">
              <dt>sync</dt>
              <dd>Your cloud</dd>
              <small>Google Drive or iCloud Drive.</small>
            </div>
            <div className="spec-item">
              <dt>size</dt>
              <dd>180 MB</dd>
              <small>After install</small>
            </div>
            <div className="spec-item">
              <dt>ai</dt>
              <dd>Optional</dd>
              <small>Local, on-device, or your own key.</small>
            </div>
            <div className="spec-item">
              <dt>plugins</dt>
              <dd>Coming soon</dd>
              <small>Install only what you need.</small>
            </div>
          </dl>
        </section>
        <SectionIndex>Demo</SectionIndex>
        <Demo wide={wide} />
        <SectionIndex>Features</SectionIndex>
        <section className="split" id="features">
          <div>
            <h2>No server. No backdoor. We cannot read it.</h2>
            <p>
              Everything is encrypted on your device with your password — including what syncs to
              your own cloud. There is no Memlore server in between, and no way back in without that
              password.
            </p>
          </div>
          <EncryptFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="sync">
          <SyncFigure />
          <div>
            <h2>Your cloud. Your account. Your key.</h2>
            <p>
              Entries are encrypted on your device, then synced through your own Google Drive or
              iCloud Drive. We never hold your files, your account, or your key.
            </p>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="locks">
          <div className="locks-copy">
            <h2>You can lock entries in 3 different ways.</h2>
            <ul className="lock-list">
              {lockItems.map((item) => {
                const Icon = lockIcons[item.id]
                return (
                  <li key={item.id}>
                    <Icon className="size-4" />
                    <p>
                      <strong>{item.title}.</strong> {item.text}
                    </p>
                  </li>
                )
              })}
            </ul>
          </div>
          <LocksFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="editor">
          <EditorFigure />
          <div>
            <h2>Feature-rich editor</h2>
            <p>
              The Editor fully supports Markdown, math, code, media, @-mentions, and optional
              plugins. It responds quickly, even with very long content.
            </p>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="emotions">
          <div>
            <h2>Emotion tracking</h2>
            <p>Your mood can be tracked and analyzed over time.</p>
          </div>
          <EmotionsFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="locations">
          <LocationsFigure />
          <div>
            <h2>Entries on a map</h2>
            <p>Entries and photos sit where they happened. Open a pin to go back to that page.</p>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="import-export">
          <div>
            <h2>Import and Export</h2>
            <p>
              You can import entries (including media) from other platforms into Memlore, and vice
              versa. Make sure the migration is seamless.
            </p>
          </div>
          <TransferFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="looks">
          <LooksFigure />
          <div>
            <h2>Make it look like yours.</h2>
            <p>
              Signature, Clean, and Clay — try them in the <a href="#demo">demo</a> above. Then keep
              going.
            </p>
            <ul className="lock-list">
              {lookItems.map((item) => (
                <li key={item.id}>
                  <item.Icon className="size-4" />
                  <p>
                    <strong>{item.title}.</strong> {item.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="talk">
          <div>
            <h2>Talk it through. Then keep the page.</h2>
            <p>
              A conversation about the day can become a journal entry when you save it. Stays off
              until you opt in.
            </p>
            <ul className="lock-list">
              {talkItems.map((item) => (
                <li key={item.id}>
                  <item.Icon className="size-4" />
                  <p>
                    <strong>{item.title}.</strong> {item.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <TalkFigure />
        </section>
        <LedgerRule />
        <section className="split split-flip" id="persona">
          <PersonaFigure />
          <div>
            <h2>Build a second you.</h2>
            <p>
              From your writing style, your memories, and how you describe yourself, Memlore builds
              a persona that writes like you — to continue a page in your voice, or sit down and
              talk to it. Stays off until you opt in.
            </p>
            <ul className="lock-list">
              {personaItems.map((item) => (
                <li key={item.id}>
                  <item.Icon className="size-4" />
                  <p>
                    <strong>{item.title}.</strong> {item.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <LedgerRule />
        <section className="split" id="plugins">
          <div>
            <h2>
              Plugins, only when you want them.
              <span className="soon-badge">Coming soon</span>
            </h2>
            <p>
              Extra tools arrive as plugins. Install one when you need it, and leave the rest out.
            </p>
          </div>
          <PluginsFigure />
        </section>
        <SectionIndex>AI</SectionIndex>
        <section className="ai-section" id="ai">
          <div className="ai-intro">
            <Sparkles className="size-7" />
            <div>
              <h2>Rich set of AI features</h2>
              <p>
                AI tools are enabled only if you opt in. Memlore supports 100% local AI, as well as
                hosted providers using your own key.
              </p>
            </div>
          </div>
          <LedgerRule />
          <div className="ai-grid">
            {aiItems.map((item) => {
              const Icon = aiIcons[item.id]
              const inner = (
                <>
                  <span className="ai-icon" aria-hidden="true">
                    <Icon className="size-5" />
                  </span>
                  <h3>{item.title}</h3>
                  {'text' in item && item.text ? <p>{item.text}</p> : null}
                </>
              )
              if (item.id === 'device') {
                return (
                  <Fragment key={item.id}>
                    <div className="ai-empty" aria-hidden="true" />
                    <article data-ai={item.id}>{inner}</article>
                  </Fragment>
                )
              }
              if ('href' in item) {
                return (
                  <a
                    key={item.id}
                    className="ai-request"
                    data-ai={item.id}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {inner}
                  </a>
                )
              }
              return (
                <article key={item.id} data-ai={item.id}>
                  {inner}
                </article>
              )
            })}
          </div>
        </section>
        <LedgerRule />
        <LedgerGap />
        <LedgerRule />
        <section className="open-section" id="open-source">
          <div className="open-symbol" aria-hidden="true">
            <Code2 className="size-16" strokeWidth={1} />
            <span>Made in the open.</span>
          </div>
          <div>
            <h2>Open source</h2>
            <p>
              Open so you can see how a journal is secured and how your data is kept. Memlore stays
              free. Beta is only for extras that keep the project going.
            </p>
            <a className="text-link" href={githubUrl} target="_blank" rel="noreferrer">
              View on GitHub <ArrowUpRight className="size-4.5" />
            </a>
          </div>
        </section>
        <LedgerRule />
        <LedgerGap />
        <LedgerRule />
        <section className="compare-section" id="compare" data-tone="raised">
          <div className="section-heading">
            <div>
              <h2>How Memlore compares.</h2>
              <p>Memlore next to three journals people already keep.</p>
            </div>
          </div>
          <LedgerRule />
          <div
            className="comparison-scroll"
            tabIndex={0}
            role="region"
            aria-label="Journal comparison table, one column per journal"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Compared</span>
                  </th>
                  {comparisonProducts.map((product) => (
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
                {comparisonRows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <strong>{row.label}</strong>
                      {row.description ? <small>{row.description}</small> : null}
                    </th>
                    {comparisonProducts.map((product) => (
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
            {comparisonProducts.map((product) => (
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
                  {comparisonRows.map((row) => (
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
          <LedgerRule />
          <p className="comparison-sources">
            Explore the details:{' '}
            {comparisonProducts
              .filter((product) => product.sourceUrl)
              .map((product) => (
                <a key={product.name} href={product.sourceUrl} target="_blank" rel="noreferrer">
                  {product.name} <ArrowUpRight className="size-3" />
                </a>
              ))}
            <span>Features and plans can change.</span>
          </p>
        </section>
        <SectionIndex>Platforms</SectionIndex>
        <section className="platform-section">
          <div>
            <h2>Multiple platforms supported</h2>
            <p>
              We’re starting with macOS and taking the time to make it feel right. Follow along as
              Memlore grows.
            </p>
          </div>
          <div className="platform-list">
            {platformItems.map((item) => {
              const Icon = platformIcons[item.name]
              return (
                <div key={item.name}>
                  <Icon className="size-5.5" />
                  <span>{item.name}</span>
                  {item.name === 'macOS' ? (
                    <strong>
                      <a
                        href={downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Download the beta from GitHub"
                      >
                        <Download className="size-3.5" /> {item.status}
                      </a>
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
        <LedgerRule />
        <div className="footer-main">
          <h2>
            The ordinary days
            <br />
            are worth keeping.
          </h2>
          <div className="button-row footer-actions">
            <DownloadLink
              className="download download-hero"
              label="Download for Mac"
              ariaLabel="Download the beta from GitHub"
            />
            <a className="button" href="#demo" data-variant="secondary">
              Try the demo
            </a>
          </div>
        </div>
        <LedgerRule />
        <SiteFooterBar homeHref="#main" />
      </footer>
    </>
  )
}
