import { cn } from '../../lib/cn'

interface ShimmerTextProps {
  /** Visible label — also mirrored into `data-text` for the ::before highlight. */
  children: string
  className?: string
  /**
   * When false, renders a plain span (no `.t-shimmer`, no `data-text`).
   * Use for labels that only shimmer while work is in flight.
   */
  active?: boolean
}

/**
 * Text with the `.t-shimmer` highlight sweep. Owns `data-text` so callers
 * cannot forget to keep the attribute in sync with the visible string —
 * required by the CSS `content: attr(data-text)` overlay.
 */
export function ShimmerText({ children, className, active = true }: ShimmerTextProps) {
  if (!active) {
    return <span className={className}>{children}</span>
  }

  return (
    <span className={cn('t-shimmer', className)} data-text={children}>
      {children}
    </span>
  )
}
