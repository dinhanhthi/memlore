import { cn } from '../../../lib/cn'

export interface SplitBarsProps {
  good: number
  neutral: number
  bad: number
  labels: {
    good: string
    neutral: string
    bad: string
  }
  ariaLabel: string
}

const ROWS = [
  { key: 'good', fill: 'bg-emotion-good', text: 'text-emotion-good' },
  { key: 'neutral', fill: 'bg-emotion-neutral', text: 'text-emotion-neutral' },
  { key: 'bad', fill: 'bg-emotion-bad', text: 'text-emotion-bad' },
] as const

function barWidth(percent: number): string {
  if (!Number.isFinite(percent)) return '0%'
  return `${Math.min(100, Math.max(0, percent))}%`
}

/** Three mood rows. Labels and integer percents come from the caller. */
export function SplitBars({ good, neutral, bad, labels, ariaLabel }: SplitBarsProps) {
  const percents = { good, neutral, bad }

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="flex h-full min-h-10 w-full flex-1 flex-col justify-center gap-2"
    >
      {ROWS.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <span className="text-fg-muted max-w-24 shrink-0 truncate text-xs">
            {labels[row.key]}
          </span>
          <div className="bg-panel-2 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
            <div
              className={cn('h-full rounded-full', row.fill)}
              style={{ width: barWidth(percents[row.key]) }}
            />
          </div>
          <span className={cn('w-9 shrink-0 text-right text-xs tabular-nums', row.text)}>
            {percents[row.key]}%
          </span>
        </div>
      ))}
    </div>
  )
}
