import { useRef, useState, type KeyboardEvent } from 'react'

type KindId = 'integrated' | 'local' | 'network' | 'cloud' | 'cli'

interface Kind {
  id: KindId
  label: string
  /** Helper that runs on this computer, drawn inside the device box. */
  inner: string[] | null
  /** Destination outside this computer; null when nothing leaves. */
  outer: string[] | null
  goes: string
  notice: string
}

// Every string here comes from docs/content/ai.md.
const KINDS: Kind[] = [
  {
    id: 'integrated',
    label: 'Integrated model',
    inner: ['Integrated', 'model'],
    outer: null,
    goes: 'Stays on this computer. The one-time download is the model, not your writing.',
    notice: 'Not asked. The request never leaves.',
  },
  {
    id: 'local',
    label: 'This computer',
    inner: ['Ollama, LM Studio', 'or llama-server'],
    outer: null,
    goes: 'Only to a helper at an address on this computer.',
    notice: 'Not asked. The request never leaves.',
  },
  {
    id: 'network',
    label: 'Your network',
    inner: null,
    outer: ['Another computer', 'on your network'],
    goes: 'To a helper on another computer on your network, such as Ollama. It still receives your journal text.',
    notice: 'Not asked.',
  },
  {
    id: 'cloud',
    label: 'Cloud provider',
    inner: null,
    outer: ['Cloud provider', 'you chose'],
    goes: 'To the cloud provider you chose, such as OpenAI or Anthropic. It sees the text of the request.',
    notice: 'Shown. You accept it first.',
  },
  {
    id: 'cli',
    label: 'Claude or Codex',
    inner: ['Claude or Codex', 'program'],
    outer: ['The company', 'behind it'],
    goes: 'To the program on this computer, which sends it on with your own login. The company behind it sees the text.',
    notice: 'Shown. You accept it first.',
  },
]

const LEFT_OUT =
  'Hidden entries, every time. Locked entries, from summaries, reviews and chat across many entries.'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Layout {
  className: string
  viewBox: string
  device: Box
  memlore: Box
  inner: Box
  outer: Box
  vertical: boolean
}

const WIDE: Layout = {
  className: 'docs-diagram-wide',
  viewBox: '0 0 720 200',
  device: { x: 16, y: 16, w: 408, h: 168 },
  memlore: { x: 40, y: 72, w: 160, h: 80 },
  inner: { x: 240, y: 72, w: 160, h: 80 },
  outer: { x: 496, y: 72, w: 208, h: 80 },
  vertical: false,
}

const NARROW: Layout = {
  className: 'docs-diagram-narrow',
  viewBox: '0 0 360 296',
  device: { x: 8, y: 8, w: 344, h: 160 },
  memlore: { x: 24, y: 64, w: 148, h: 80 },
  inner: { x: 188, y: 64, w: 148, h: 80 },
  outer: { x: 60, y: 208, w: 240, h: 72 },
  vertical: true,
}

function Node({ box, lines, className }: { box: Box; lines: string[]; className: string }) {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return (
    <g className={className}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="12" strokeWidth="2" />
      <text className="ap-label" textAnchor="middle">
        {lines.map((line, j) => (
          <tspan key={line} x={cx} y={cy + 6 + (j - (lines.length - 1) / 2) * 20}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}

/** Path from box a to box b, ending in an arrow head. */
function linkPath(a: Box, b: Box, vertical: boolean): { line: string; head: string } {
  if (!vertical) {
    const y = b.y + b.h / 2
    const x1 = a.x + a.w
    const x2 = b.x - 4
    return { line: `M${x1} ${y}H${x2}`, head: `M${x2 - 8} ${y - 6}l8 6-8 6` }
  }
  const x1 = a.x + a.w / 2
  const x2 = b.x + b.w / 2
  const y1 = a.y + a.h
  const y2 = b.y - 4
  const mid = (y1 + y2) / 2 + 8
  return {
    line: `M${x1} ${y1}V${mid}H${x2}V${y2}`,
    head: `M${x2 - 6} ${y2 - 8}l6 8 6-8`,
  }
}

function Illustration({ layout, kind }: { layout: Layout; kind: Kind }) {
  const { device, memlore, inner, outer, vertical } = layout
  const from = kind.inner ? inner : memlore
  const inside = kind.inner ? linkPath(memlore, inner, false) : null
  const leaving = kind.outer ? linkPath(from, outer, vertical) : null
  const titleId = `ai-provider-title-${layout.className}`
  const descId = `ai-provider-desc-${layout.className}`
  return (
    <svg
      className={layout.className}
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descId}
      viewBox={layout.viewBox}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={titleId}>Where an AI request goes: {kind.label}</title>
      <desc id={descId}>{kind.goes}</desc>
      <rect
        className="ap-device"
        x={device.x}
        y={device.y}
        width={device.w}
        height={device.h}
        rx="16"
        strokeWidth="2"
      />
      <text className="ap-label" x={device.x + 20} y={device.y + 32}>
        This computer
      </text>
      <Node box={memlore} lines={['Memlore']} className="ap-node" />
      {kind.inner ? <Node box={inner} lines={kind.inner} className="ap-node ap-helper" /> : null}
      {inside ? (
        <g className="ap-link" data-leaves="false">
          <path d={inside.line} fill="none" />
          <path d={inside.head} fill="none" />
        </g>
      ) : null}
      {leaving && kind.outer ? (
        <>
          <g className="ap-link" data-leaves="true">
            <path d={leaving.line} fill="none" />
            <path d={leaving.head} fill="none" />
          </g>
          <Node box={outer} lines={kind.outer} className="ap-node ap-outer" />
        </>
      ) : (
        <Node box={outer} lines={['Nothing leaves', 'this computer']} className="ap-node ap-none" />
      )}
    </svg>
  )
}

export function AiProvider() {
  const [current, setCurrent] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const kind = KINDS[current]

  const select = (i: number) => {
    setCurrent(i)
    tabs.current[i]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const last = KINDS.length - 1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') select(current === last ? 0 : current + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      select(current === 0 ? last : current - 1)
    else if (e.key === 'Home') select(0)
    else if (e.key === 'End') select(last)
    else return
    e.preventDefault()
  }

  return (
    <figure className="docs-widget docs-widget-ai-provider">
      <figcaption className="docs-widget-title" id="ai-provider-title">
        Where the request goes for each kind of helper
      </figcaption>
      <div
        className="docs-widget-controls"
        role="tablist"
        aria-labelledby="ai-provider-title"
        onKeyDown={onKeyDown}
      >
        {KINDS.map((k, i) => (
          <button
            key={k.id}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`ai-provider-tab-${k.id}`}
            aria-selected={i === current}
            aria-controls="ai-provider-panel"
            tabIndex={i === current ? 0 : -1}
            onClick={() => setCurrent(i)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div
        className="le-panel"
        role="tabpanel"
        id="ai-provider-panel"
        aria-labelledby={`ai-provider-tab-${kind.id}`}
      >
        <Illustration layout={WIDE} kind={kind} />
        <Illustration layout={NARROW} kind={kind} />
        <dl className="le-features" aria-live="polite">
          <div>
            <dt>Where your text goes</dt>
            <dd>{kind.goes}</dd>
          </div>
          <div>
            <dt>Privacy notice</dt>
            <dd>{kind.notice}</dd>
          </div>
          <div>
            <dt>Always left out</dt>
            <dd>{LEFT_OUT}</dd>
          </div>
        </dl>
      </div>
      <p className="docs-widget-caption">
        A helper on your network gets your journal text without a privacy notice.
      </p>
    </figure>
  )
}
