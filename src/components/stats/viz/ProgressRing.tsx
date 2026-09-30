import type { CSSProperties } from 'react'
import { ringFraction } from '../../../lib/vizMath'
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion'
import { cn } from '../../../lib/cn'
import { VIZ_TONE, vizStrokeMotionClass, type VizTone } from './vizTone'

export interface ProgressRingProps {
  value: number
  goal: number
  tone: VizTone
  ariaLabel: string
}

/** Two circles: a token wash track and an arc of `value / goal`. */
export function ProgressRing({ value, goal, tone, ariaLabel }: ProgressRingProps) {
  const reduced = usePrefersReducedMotion()
  const fraction = ringFraction(value, goal)
  const toneClass = VIZ_TONE[tone]
  const drawStyle = { '--viz-draw': String(1 - fraction) } as CSSProperties

  return (
    <div className="relative h-full min-h-10 w-full flex-1">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox="0 0 36 36"
        className="absolute inset-0 size-full"
      >
        <circle
          cx="18"
          cy="18"
          r="14"
          strokeWidth={3}
          className={cn('fill-none', toneClass.track)}
        />
        {fraction > 0 ? (
          <circle
            cx="18"
            cy="18"
            r="14"
            strokeWidth={3}
            pathLength={1}
            strokeDasharray={1}
            strokeLinecap="round"
            transform="rotate(-90 18 18)"
            style={drawStyle}
            className={cn(
              'fill-none [stroke-dashoffset:var(--viz-draw)]',
              toneClass.stroke,
              !reduced && vizStrokeMotionClass,
            )}
          />
        ) : null}
      </svg>
    </div>
  )
}
