import { cn } from '../../lib/cn'

/**
 * "All Journals" identity marker — a circular disc filled with a conic
 * rainbow gradient. It is the visual counterpart to the solid color dot
 * used for an individual journal, conveying "many journals (many colors)
 * rolled into one".
 *
 * The caller controls size and shape via `className` (e.g. `size-4`,
 * `h-2 w-2`) so it can match the surrounding single-journal dot.
 *
 * The gradient hex stops are intentionally hardcoded: a rainbow has no
 * semantic counterpart in the OKLCH token system, so promoting them to
 * tokens would add noise without meaning. Six ROYGBV-equivalent bands
 * are used (not eight) so the rainbow stays legible at the smallest
 * rendered size — the 8px (h-2 w-2) dot in the picker popover rows.
 */
const RAINBOW_CONIC =
  'conic-gradient(from 0deg, #ef4444, #f59e0b, #10b981, #06b6d4, #3b82f6, #db2777, #ef4444)'

interface JournalAllIconProps {
  className?: string
  /** When omitted, the disc is decorative (aria-hidden). */
  ariaLabel?: string
}

export function JournalAllIcon({ className, ariaLabel }: JournalAllIconProps) {
  return (
    <span
      aria-hidden={ariaLabel ? undefined : 'true'}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
      className={cn(
        'inline-block shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10',
        className,
      )}
      style={{ background: RAINBOW_CONIC }}
    />
  )
}
