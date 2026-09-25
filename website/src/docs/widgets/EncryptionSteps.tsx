import { useState } from 'react'

interface Step {
  name: string
  node: string
  sub: string
  caption: string
}

// Every string here comes from docs/content/encryption.md.
const STEPS: Step[] = [
  {
    name: 'Your password',
    node: 'Your password',
    sub: 'not the key',
    caption:
      'Your password is not the key inside the journal. The app uses it, slowly, to open a locked box that holds a random master key.',
  },
  {
    name: 'Argon2id',
    node: 'Argon2id',
    sub: 'wrapping key',
    caption:
      'The app turns your password into a wrapping key with Argon2id, a slow step that makes guessing expensive.',
  },
  {
    name: 'Master key',
    node: 'Master key',
    sub: 'AES-256-GCM seal',
    caption:
      'The wrapping key seals a master key made of random bytes, with AES-256-GCM. The database is not locked with the password itself.',
  },
  {
    name: 'Journal database',
    node: 'Journal database',
    sub: 'SQLCipher',
    caption:
      'SQLCipher encrypts each page of the file. Without the key, it does not open as a database.',
  },
  {
    name: '24 recovery words',
    node: 'Recovery words',
    sub: 'no Argon2id',
    caption:
      'The 24 recovery words open the same box by another lock. They become a key without Argon2id, because the words are already a long random secret.',
  },
]

const RECOVERY = 4

type State = 'done' | 'current' | 'todo'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Layout {
  className: string
  viewBox: string
  nodes: Box[]
  // Connector path for nodes[i]: 1-3 lead into it from the step before; 4 leads from
  // the recovery node up into the master key. Index 0 has none.
  links: (string | null)[]
  arrows: (string | null)[]
}

const WIDE: Layout = {
  className: 'docs-diagram-wide',
  viewBox: '0 0 720 264',
  nodes: [
    { x: 8, y: 24, w: 158, h: 80 },
    { x: 192, y: 24, w: 158, h: 80 },
    { x: 376, y: 24, w: 158, h: 80 },
    { x: 560, y: 24, w: 152, h: 80 },
    { x: 376, y: 176, w: 158, h: 80 },
  ],
  links: [null, 'M166 64H188', 'M350 64H372', 'M534 64H556', 'M455 176V108'],
  arrows: [null, 'M180 58l8 6-8 6', 'M364 58l8 6-8 6', 'M548 58l8 6-8 6', 'M449 116l6-8 6 8'],
}

const NARROW: Layout = {
  className: 'docs-diagram-narrow',
  viewBox: '0 0 360 428',
  nodes: [
    { x: 8, y: 8, w: 196, h: 76 },
    { x: 8, y: 120, w: 196, h: 76 },
    { x: 8, y: 232, w: 196, h: 76 },
    { x: 8, y: 344, w: 196, h: 76 },
    { x: 232, y: 232, w: 120, h: 76 },
  ],
  links: [null, 'M106 84V116', 'M106 196V228', 'M106 308V340', 'M232 270H208'],
  arrows: [null, 'M100 108l6 8 6-8', 'M100 220l6 8 6-8', 'M100 332l6 8 6-8', 'M216 264l-8 6 8 6'],
}

function stateOf(i: number, current: number): State {
  if (i === current) return 'current'
  if (current === RECOVERY) return 'done'
  if (i === RECOVERY) return 'todo'
  return i < current ? 'done' : 'todo'
}

function nodeLines(step: Step, box: Box): string[] {
  // The narrow recovery node is too slim for "Recovery words" on one line.
  return box.w < 150 && step.node.includes(' ') ? step.node.split(' ') : [step.node]
}

function Illustration({ layout, current }: { layout: Layout; current: number }) {
  const titleId = `encryption-steps-title-${layout.className}`
  const descId = `encryption-steps-desc-${layout.className}`
  return (
    <svg
      className={layout.className}
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descId}
      viewBox={layout.viewBox}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={titleId}>From your password to the journal database</title>
      <desc id={descId}>
        Your password goes through Argon2id to make a wrapping key, which opens the sealed master
        key, which reaches the journal database. The 24 recovery words open the same master key box
        by another lock.
      </desc>
      {layout.links.map((d, i) =>
        d ? (
          <g key={`link-${i}`} className="es-link" data-state={stateOf(i, current)}>
            <path d={d} fill="none" />
            <path className="es-arrow" d={layout.arrows[i] ?? ''} fill="none" />
          </g>
        ) : null,
      )}
      {STEPS.map((step, i) => {
        const box = layout.nodes[i]
        const cx = box.x + box.w / 2
        const lines = nodeLines(step, box)
        const top = box.y + box.h / 2 - ((lines.length + 1) * 20) / 2 + 15
        return (
          <g key={step.name} className="es-node" data-state={stateOf(i, current)}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="12" />
            <text className="es-label" textAnchor="middle">
              {lines.map((line, j) => (
                <tspan key={line} x={cx} y={top + j * 20}>
                  {line}
                </tspan>
              ))}
            </text>
            <text className="es-sub" x={cx} y={top + lines.length * 20} textAnchor="middle">
              {step.sub}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function EncryptionSteps() {
  const [current, setCurrent] = useState(0)
  const step = STEPS[current]

  return (
    <figure className="docs-widget docs-widget-encryption-steps">
      <figcaption className="docs-widget-title">
        Your password opens a locked box. The master key inside reaches the journal.
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
