import { sparklinePoints } from '../../../lib/vizMath'
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion'
import { cn } from '../../../lib/cn'
import { VIZ_TONE, vizStrokeMotionClass, type VizTone } from './vizTone'

export interface SparklineProps {
  values: number[]
  tone: VizTone
  ariaLabel: string
}

const VIEW_W = 120
const VIEW_H = 36
const PAD = 2

/** SVG polyline. Stroke colour is a class so PNG export can inline it. */
export function Sparkline({ values, tone, ariaLabel }: SparklineProps) {
  const reduced = usePrefersReducedMotion()
  const points = sparklinePoints(values, VIEW_W, VIEW_H, PAD)

  return (
    <div className="relative h-full min-h-10 w-full flex-1">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        {points !== '' ? (
          <polyline
            points={points}
            pathLength={1}
            strokeDasharray={1}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className={cn(
              'fill-none stroke-2 [stroke-dashoffset:0]',
              VIZ_TONE[tone].stroke,
              !reduced && vizStrokeMotionClass,
            )}
          />
        ) : null}
      </svg>
    </div>
  )
}
