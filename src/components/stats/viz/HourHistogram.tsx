import { normalize, peakHour } from '../../../lib/vizMath'
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion'
import { cn } from '../../../lib/cn'
import { vizBarMotionClass, vizBarStillClass } from './vizTone'

export interface HourHistogramProps {
  hours: { hour: number; count: number }[]
  ariaLabel: string
}

const PEAK_BAR = 'bg-viz-6'
const QUIET_BAR = 'bg-viz-6/35'

function countsForDay(hours: { hour: number; count: number }[]): number[] {
  const counts = Array.from({ length: 24 }, () => 0)
  for (const row of hours) {
    if (row.hour >= 0 && row.hour < 24) {
      counts[row.hour] = Math.max(counts[row.hour], row.count)
    }
  }
  return counts
}

/** 24 hour bars. The peak hour is full viz-6; the rest are quieter. */
export function HourHistogram({ hours, ariaLabel }: HourHistogramProps) {
  const reduced = usePrefersReducedMotion()
  const counts = countsForDay(hours)
  const heights = normalize(counts, 100)
  const peak = peakHour(hours)

  return (
    <div role="img" aria-label={ariaLabel} className="relative h-full min-h-10 w-full flex-1">
      <div className="absolute inset-0 flex items-end gap-px">
        {heights.map((height, hour) => (
          <div key={hour} className="flex h-full min-w-0 flex-1 items-end">
            <div
              className={cn(
                'w-full rounded-t-sm',
                peak === hour ? PEAK_BAR : QUIET_BAR,
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
