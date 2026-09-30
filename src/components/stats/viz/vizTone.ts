/** Categorical tones for story-in-numbers tiles. Full class strings so Tailwind sees them. */

export type VizTone = 1 | 2 | 3 | 4 | 5 | 6

interface VizToneClasses {
  text: string
  chipBg: string
  stroke: string
  fill: string
  /** Token gradient: solid viz at the top, viz/40 at the base. */
  bar: string
  /** Ring track wash. */
  track: string
}

export const VIZ_TONE = {
  1: {
    text: 'text-viz-1',
    chipBg: 'bg-viz-1/15',
    stroke: 'stroke-viz-1',
    fill: 'fill-viz-1',
    bar: 'bg-linear-to-t from-viz-1/40 to-viz-1',
    track: 'stroke-viz-1/15',
  },
  2: {
    text: 'text-viz-2',
    chipBg: 'bg-viz-2/15',
    stroke: 'stroke-viz-2',
    fill: 'fill-viz-2',
    bar: 'bg-linear-to-t from-viz-2/40 to-viz-2',
    track: 'stroke-viz-2/15',
  },
  3: {
    text: 'text-viz-3',
    chipBg: 'bg-viz-3/15',
    stroke: 'stroke-viz-3',
    fill: 'fill-viz-3',
    bar: 'bg-linear-to-t from-viz-3/40 to-viz-3',
    track: 'stroke-viz-3/15',
  },
  4: {
    text: 'text-viz-4',
    chipBg: 'bg-viz-4/15',
    stroke: 'stroke-viz-4',
    fill: 'fill-viz-4',
    bar: 'bg-linear-to-t from-viz-4/40 to-viz-4',
    track: 'stroke-viz-4/15',
  },
  5: {
    text: 'text-viz-5',
    chipBg: 'bg-viz-5/15',
    stroke: 'stroke-viz-5',
    fill: 'fill-viz-5',
    bar: 'bg-linear-to-t from-viz-5/40 to-viz-5',
    track: 'stroke-viz-5/15',
  },
  6: {
    text: 'text-viz-6',
    chipBg: 'bg-viz-6/15',
    stroke: 'stroke-viz-6',
    fill: 'fill-viz-6',
    bar: 'bg-linear-to-t from-viz-6/40 to-viz-6',
    track: 'stroke-viz-6/15',
  },
} as const satisfies Record<VizTone, VizToneClasses>

/**
 * Bar grow. Apply only when `usePrefersReducedMotion()` is false.
 * `motion-safe:` also skips the transition under the OS media query.
 */
export const vizBarMotionClass =
  'origin-bottom scale-y-100 motion-safe:starting:scale-y-0 motion-safe:transition-transform motion-safe:duration-(--motion-duration-slow) motion-safe:ease-(--motion-ease-out-expo)'

/** Final bar scale, with no entrance transition. */
export const vizBarStillClass = 'origin-bottom scale-y-100'

/**
 * Dash-draw for a stroke whose end offset is `0` or `var(--viz-draw)`.
 * Apply only when `usePrefersReducedMotion()` is false.
 */
export const vizStrokeMotionClass =
  'motion-safe:starting:[stroke-dashoffset:1] motion-safe:transition-[stroke-dashoffset] motion-safe:duration-(--motion-duration-slow) motion-safe:ease-(--motion-ease-out-expo)'
