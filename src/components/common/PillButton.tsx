import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
}

/** Pill-styled button that accepts arbitrary button props. The project's
 * `<Pill>` primitive drops spread props, which conflicts with floating-ui's
 * `getReferenceProps()` injection. This variant preserves spread. */
export const PillButton = forwardRef<HTMLButtonElement, PillButtonProps>(function PillButton(
  { selected, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        'text-2xs inline-flex h-6 cursor-pointer items-center gap-1 rounded-(--button-radius) border px-2 font-mono whitespace-nowrap transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
        selected
          ? 'bg-accent-soft border-accent/40 text-accent-text'
          : 'bg-elevated border-border-default text-fg-muted hover:bg-surface-hi hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  )
})
