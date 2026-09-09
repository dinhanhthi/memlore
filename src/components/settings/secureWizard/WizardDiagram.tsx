export type WizardDiagramVariant = 'two-devices' | 'key-rotated' | 'cloud-cut' | 'phrase-new'

interface WizardDiagramProps {
  variant: WizardDiagramVariant
  ariaLabel: string
}

const sharedStroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  strokeWidth: 2,
} as const

function Device({ x, accent = false }: { x: number; accent?: boolean }) {
  return (
    <g className={accent ? 'text-accent' : 'text-fg-muted'}>
      <rect x={x} y="66" width="48" height="34" rx="4" {...sharedStroke} />
      <path d={`M${x - 4} 106h56`} {...sharedStroke} />
      <circle cx={x + 24} cy="83" r="3" className="fill-current" />
    </g>
  )
}

function Cloud({ x, className }: { x: number; className: string }) {
  return (
    <path
      d={`M${x} 45h36a10 10 0 0 0 2-19 15 15 0 0 0-28-4A12 12 0 0 0 ${x} 45Z`}
      className={className}
      {...sharedStroke}
    />
  )
}

function TwoDevicesDiagram() {
  return (
    <>
      <Cloud x={82} className="text-accent" />
      <g className="text-fg-muted">
        <path d="M91 48 58 66M111 48l33 18" {...sharedStroke} />
      </g>
      <Device x={28} accent />
      <Device x={124} />
    </>
  )
}

function KeyRotatedDiagram() {
  return (
    <>
      <g className="text-fg-muted">
        <circle cx="48" cy="60" r="14" {...sharedStroke} />
        <path d="m58 70 24 24m-8-8 7-7m-14 0 7-7" {...sharedStroke} />
      </g>
      <path d="m28 32 54 64" className="text-danger" {...sharedStroke} strokeWidth="3" />
      <path d="M91 62h24" className="text-accent" {...sharedStroke} />
      <path d="m109 56 6 6-6 6" className="text-accent" {...sharedStroke} />
      <g className="text-success">
        <circle cx="148" cy="60" r="14" {...sharedStroke} />
        <path d="m158 70 24 24m-8-8 7-7m-14 0 7-7" {...sharedStroke} />
        <circle cx="148" cy="60" r="5" className="fill-current opacity-20" />
      </g>
    </>
  )
}

function CloudCutDiagram() {
  return (
    <>
      <Device x={22} />
      <Cloud x={146} className="text-accent" />
      <path
        d="M74 82c26-30 47-30 72-42"
        className="text-fg-muted"
        strokeDasharray="5 6"
        {...sharedStroke}
      />
      <g className="text-danger">
        <circle cx="111" cy="61" r="14" className="fill-current opacity-10" />
        <path d="m101 72 20-22" {...sharedStroke} strokeWidth="3" />
      </g>
    </>
  )
}

function PhraseNewDiagram() {
  return (
    <>
      <g className="text-fg-muted">
        <rect x="26" y="28" width="86" height="70" rx="6" strokeDasharray="5 5" {...sharedStroke} />
        <path
          d="M40 45h24m8 0h24M40 58h18m8 0h30M40 71h26m8 0h22M40 84h20m8 0h28"
          {...sharedStroke}
        />
      </g>
      <path d="M110 62h18" className="text-accent" {...sharedStroke} />
      <path d="m122 56 6 6-6 6" className="text-accent" {...sharedStroke} />
      <g className="text-success">
        <rect x="132" y="22" width="62" height="82" rx="6" className="fill-current opacity-10" />
        <rect x="132" y="22" width="62" height="82" rx="6" {...sharedStroke} />
        <path d="M145 40h36M145 52h36M145 64h36M145 76h36" {...sharedStroke} />
        <path d="m158 91 7 7 15-17" {...sharedStroke} />
      </g>
    </>
  )
}

export function WizardDiagram({ variant, ariaLabel }: WizardDiagramProps) {
  return (
    <svg
      aria-label={ariaLabel}
      className="h-32 w-full max-w-56"
      role="img"
      viewBox="0 0 220 128"
      xmlns="http://www.w3.org/2000/svg"
    >
      {variant === 'two-devices' && <TwoDevicesDiagram />}
      {variant === 'key-rotated' && <KeyRotatedDiagram />}
      {variant === 'cloud-cut' && <CloudCutDiagram />}
      {variant === 'phrase-new' && <PhraseNewDiagram />}
    </svg>
  )
}
