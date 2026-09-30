import { normalize } from '../../../lib/vizMath'
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion'
import { cn } from '../../../lib/cn'
import { VIZ_TONE, vizBarMotionClass, vizBarStillClass, type VizTone } from './vizTone'

export interface MiniBarsProps {
  values: number[]
  tone: VizTone
  ariaLabel: string
}

/** Column bars. Height is normalized; grow is scaleY under motion-safe. */
export function MiniBars({ values, tone, ariaLabel }: MiniBarsProps) {
  const reduced = usePrefersReducedMotion()
  const heights = normalize(values, 100)

  return (
    <div role="img" aria-label={ariaLabel} className="relative h-full min-h-10 w-full flex-1">
      <div className="absolute inset-0 flex items-end gap-0.5">
        {heights.map((height, index) => (
          <div key={index} className="flex h-full min-w-0 flex-1 items-end">
            <div
              className={cn(
                'w-full rounded-t-sm',
                VIZ_TONE[tone].bar,
                reduced ? vizBarStillClass : vizBarMotionClass,
              )}
              style={{ height: `${height}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
