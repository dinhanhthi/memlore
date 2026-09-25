import { useState } from 'react'

type Part = 'a' | 'seal' | 'up' | 'cloud' | 'down' | 'b' | 'open'

interface Step {
  name: string
  caption: string
  active: Part[]
}

// Every string here comes from docs/content/sync.md.
const STEPS: Step[] = [
  {
    name: 'You write',
    caption:
      'Your journal works with sync off. When you turn sync on, your devices copy the journal through one place you already control. There is no Memlore server between them.',
    active: ['a'],
  },
  {
    name: 'Sealed on this device',
    caption:
      'Before a file leaves this device, Memlore seals it. Entries, photos and other attachments, journal names, settings, and chats all go out sealed.',
    active: ['seal'],
  },
  {
    name: 'The cloud folder',
    caption:
      "The cloud holds a folder of sealed envelopes. It can store them and hand them to your other device. It cannot open them. The sync list and the device list stay readable, so your devices know what to fetch. Neither includes the words you wrote, but the cloud can read each device's name.",
    active: ['up', 'cloud'],
  },
  {
    name: 'Your other device',
    caption:
      'Your other device downloads the sealed files. Google and Apple do not combine the writing. Your device opens the envelopes itself.',
    active: ['down', 'b', 'open'],
  },
  {
    name: 'Both sides kept',
    caption:
      'If you edit the same entry on two devices before they sync, the writing inside the entry is kept from both sides. A title, a journal name, or a setting keeps the later save.',
    active: ['a', 'b'],
  },
]

// The step that first shows each part. Earlier steps draw it as not yet reached.
const INTRO: Record<Part, number> = { a: 0, seal: 1, up: 2, cloud: 2, down: 3, b: 3, open: 3 }

type State = 'done' | 'current' | 'todo'

function stateOf(part: Part, current: number): State {
  if (STEPS[current].active.includes(part)) return 'current'
  return INTRO[part] < current ? 'done' : 'todo'
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Node {
  part: Part
  box: Box
  label: string
  sub?: string
}

interface Layout {
  className: string
  viewBox: string
  // Outer boxes first, so the seal/open chips paint on top of their device.
  nodes: Node[]
  links: { part: Part; line: string; arrow: string }[]
}

const WIDE: Layout = {
  className: 'docs-diagram-wide',
  viewBox: '0 0 720 200',
  nodes: [
    { part: 'a', box: { x: 8, y: 8, w: 200, h: 184 }, label: 'This device', sub: 'you write' },
    {
      part: 'cloud',
      box: { x: 260, y: 8, w: 200, h: 184 },
      label: 'Cloud folder',
      sub: 'sealed files',
    },
    { part: 'b', box: { x: 512, y: 8, w: 200, h: 184 }, label: 'Other device', sub: 'downloads' },
    { part: 'seal', box: { x: 48, y: 116, w: 120, h: 48 }, label: 'Seal' },
    { part: 'open', box: { x: 552, y: 116, w: 120, h: 48 }, label: 'Open' },
  ],
  links: [
    { part: 'up', line: 'M208 100H252', arrow: 'M244 94l8 6-8 6' },
    { part: 'down', line: 'M460 100H504', arrow: 'M496 94l8 6-8 6' },
  ],
}

const NARROW: Layout = {
  className: 'docs-diagram-narrow',
  viewBox: '0 0 360 552',
  nodes: [
    { part: 'a', box: { x: 60, y: 8, w: 240, h: 152 }, label: 'This device', sub: 'you write' },
    {
      part: 'cloud',
      box: { x: 60, y: 200, w: 240, h: 152 },
      label: 'Cloud folder',
      sub: 'sealed files',
    },
    { part: 'b', box: { x: 60, y: 392, w: 240, h: 152 }, label: 'Other device', sub: 'downloads' },
    { part: 'seal', box: { x: 120, y: 96, w: 120, h: 48 }, label: 'Seal' },
    { part: 'open', box: { x: 120, y: 480, w: 120, h: 48 }, label: 'Open' },
  ],
  links: [
    { part: 'up', line: 'M180 160V192', arrow: 'M174 184l6 8 6-8' },
    { part: 'down', line: 'M180 352V384', arrow: 'M174 376l6 8 6-8' },
  ],
}

function Illustration({ layout, current }: { layout: Layout; current: number }) {
  const titleId = `sync-steps-title-${layout.className}`
  const descId = `sync-steps-desc-${layout.className}`
  return (
    <svg
      className={layout.className}
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descId}
      viewBox={layout.viewBox}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={titleId}>How sync moves your journal between devices</title>
      <desc id={descId}>
        This device seals each file, then uploads it to the cloud folder. The cloud cannot open the
        sealed files. Your other device downloads them and opens them itself.
      </desc>
      {layout.links.map((link) => (
        <g key={link.part} className="es-link" data-state={stateOf(link.part, current)}>
          <path d={link.line} fill="none" />
          <path className="es-arrow" d={link.arrow} fill="none" />
        </g>
      ))}
      {layout.nodes.map(({ part, box, label, sub }) => {
        const cx = box.x + box.w / 2
        // Device and cloud labels sit at the top of the box; chip labels are centred.
        const top = sub ? box.y + 36 : box.y + box.h / 2 + 6
        return (
          <g key={part} className="es-node" data-state={stateOf(part, current)}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="12" />
            <text className="es-label" x={cx} y={top} textAnchor="middle">
              {label}
            </text>
            {sub ? (
              <text className="es-sub" x={cx} y={top + 22} textAnchor="middle">
                {sub}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

export function SyncSteps() {
  const [current, setCurrent] = useState(0)
  const step = STEPS[current]

  return (
    <figure className="docs-widget docs-widget-sync-steps">
      <figcaption className="docs-widget-title">
        Each device seals its entries, then uploads them. The cloud can store them, but it cannot
        open them.
      </figcaption>
      <div className="docs-widget-controls">
        <button
          type="button"
          aria-disabled={current === 0 ? 'true' : undefined}
          onClick={() => setCurrent((i) => Math.max(0, i - 1))}
        >
          Previous
        </button>
        {STEPS.map((s, i) => (
          <button
            key={s.name}
            type="button"
            className="es-dot"
            aria-label={`Step ${i + 1}: ${s.name}`}
            aria-current={i === current ? 'step' : undefined}
            onClick={() => setCurrent(i)}
          >
            {i + 1}
          </button>
        ))}
        <button
          type="button"
          aria-disabled={current === STEPS.length - 1 ? 'true' : undefined}
          onClick={() => setCurrent((i) => Math.min(STEPS.length - 1, i + 1))}
        >
          Next
        </button>
      </div>
      <Illustration layout={WIDE} current={current} />
      <Illustration layout={NARROW} current={current} />
      <div className="docs-widget-caption es-caption" aria-live="polite">
        <strong className="es-caption-title">
          Step {current + 1} of {STEPS.length}: {step.name}
        </strong>
        <span>{step.caption}</span>
      </div>
    </figure>
  )
}
