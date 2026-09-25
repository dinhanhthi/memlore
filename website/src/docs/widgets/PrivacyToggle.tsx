import { useState } from 'react'

type FeatureId = 'sync' | 'ai' | 'maps' | 'fonts'

interface Feature {
  id: FeatureId
  toggle: string
  node: string[]
  caption: string
}

// Every string here comes from docs/content/how-privacy-works.md.
const FEATURES: Feature[] = [
  {
    id: 'sync',
    toggle: 'Sync',
    node: ['Google Drive', 'or iCloud Drive'],
    caption:
      'Sync: encrypted copies, plus a short sync list, go to your Google Drive, or your iCloud Drive on a Mac.',
  },
  {
    id: 'ai',
    toggle: 'AI',
    node: ['AI provider'],
    caption:
      'AI: text you choose to send, if you turn on a hosted AI provider. A helper on another computer on your network also gets your journal text, with no privacy notice.',
  },
  {
    id: 'maps',
    toggle: 'Maps and weather',
    node: ['Map and weather', 'services'],
    caption:
      'Maps and weather: a place search, map pictures, or the weather for a date. Not your entry text.',
  },
  {
    id: 'fonts',
    toggle: 'Fonts',
    node: ['Google fonts'],
    caption: 'Fonts: a font file, if you download a Google font. Your journal is not sent with it.',
  },
]

const ALL_OFF = 'Nothing goes out on an arrow until you turn that switch on.'
const UPDATE_CHECK = 'Update check: a version check to GitHub, unless you turn that check off.'

interface Layout {
  className: string
  viewBox: string
  device: { x: number; y: number; w: number; h: number }
  lockX: number
  lockY: number
  rows: number[]
  lineFrom: number
  lineTo: number
  node: { x: number; w: number; h: number }
  memloreY: number
}

const WIDE: Layout = {
  className: 'docs-diagram-wide',
  viewBox: '0 0 720 368',
  device: { x: 16, y: 16, w: 208, h: 336 },
  lockX: 120,
  lockY: 150,
  rows: [48, 124, 200, 276],
  lineFrom: 224,
  lineTo: 484,
  node: { x: 496, w: 208, h: 60 },
  memloreY: 332,
}

const NARROW: Layout = {
  className: 'docs-diagram-narrow',
  viewBox: '0 0 360 384',
  device: { x: 8, y: 8, w: 120, h: 368 },
  lockX: 68,
  lockY: 160,
  rows: [44, 120, 196, 272],
  lineFrom: 128,
  lineTo: 180,
  node: { x: 192, w: 160, h: 60 },
  memloreY: 344,
}

function Illustration({ layout, on }: { layout: Layout; on: Set<FeatureId> }) {
  const { device, lockX, lockY, node } = layout
  const nodeCx = node.x + node.w / 2
  return (
    <svg
      className={layout.className}
      role="img"
      aria-labelledby={`privacy-toggle-title-${layout.className}`}
      aria-describedby={`privacy-toggle-desc-${layout.className}`}
      viewBox={layout.viewBox}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={`privacy-toggle-title-${layout.className}`}>
        Your device, with one switchable path to each optional service
      </title>
      <desc id={`privacy-toggle-desc-${layout.className}`}>
        Your journal sits locked on your device. Arrows lead to sync, AI, maps and weather, and
        fonts services, and light up only when that switch is on. There is no Memlore server.
      </desc>
      <rect
        className="pt-device"
        x={device.x}
        y={device.y}
        width={device.w}
        height={device.h}
        rx="16"
      />
      <text className="pt-label" x={lockX} y={device.y + 32} textAnchor="middle">
        Your device
      </text>
      <path
        className="pt-lock pt-shackle"
        d={`M${lockX - 24} ${lockY}v-14a24 24 0 0 1 48 0v14`}
        fill="none"
        strokeWidth="3"
      />
      <rect
        className="pt-lock"
        x={lockX - 34}
        y={lockY - 4}
        width="68"
        height="56"
        rx="10"
        strokeWidth="2"
      />
      <text className="pt-label" x={lockX} y={lockY + 84} textAnchor="middle">
        Journal
      </text>
      {FEATURES.map((feature, i) => {
        const cy = layout.rows[i]
        const lit = on.has(feature.id)
        return (
          <g key={feature.id} className="pt-path" data-on={lit}>
            <path
              className="pt-line"
              d={`M${layout.lineFrom} ${cy}H${layout.lineTo}`}
              fill="none"
              strokeWidth="2"
            />
            <path
              className="pt-line pt-arrow"
              d={`M${layout.lineTo - 8} ${cy - 6}l12 6-12 6`}
              fill="none"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <rect
              className="pt-node"
              x={node.x}
              y={cy - node.h / 2}
              width={node.w}
              height={node.h}
              rx="12"
              strokeWidth="2"
            />
            <text className="pt-label" x={nodeCx} textAnchor="middle">
              {feature.node.map((line, j) => (
                <tspan key={line} x={nodeCx} y={cy + 5 + (j - (feature.node.length - 1) / 2) * 20}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        )
      })}
      <rect
        className="pt-memlore"
        x={node.x}
        y={layout.memloreY - 20}
        width={node.w}
        height="40"
        rx="12"
        strokeWidth="2"
      />
      <text className="pt-muted" x={nodeCx} y={layout.memloreY + 5} textAnchor="middle">
        No Memlore server
      </text>
    </svg>
  )
}

export function PrivacyToggle() {
  const [on, setOn] = useState<Set<FeatureId>>(() => new Set())

  const toggle = (id: FeatureId) =>
    setOn((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const enabled = FEATURES.filter((feature) => on.has(feature.id))

  return (
    <figure className="docs-widget docs-widget-privacy-toggle">
      <figcaption className="docs-widget-title">
        Each path stays off until you turn it on, except the update check.
      </figcaption>
      <div className="docs-widget-controls">
        {FEATURES.map((feature) => (
          <button
            key={feature.id}
            type="button"
            aria-pressed={on.has(feature.id)}
            onClick={() => toggle(feature.id)}
          >
            {feature.toggle}
          </button>
        ))}
      </div>
      <Illustration layout={WIDE} on={on} />
      <Illustration layout={NARROW} on={on} />
      <ul className="docs-widget-caption pt-captions" aria-live="polite">
        {enabled.length === 0 ? (
          <li>{ALL_OFF}</li>
        ) : (
          enabled.map((feature) => <li key={feature.id}>{feature.caption}</li>)
        )}
      </ul>
      <p className="docs-widget-caption pt-always">{UPDATE_CHECK}</p>
    </figure>
  )
}
