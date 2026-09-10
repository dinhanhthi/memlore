import {
  useFloating,
  useHover,
  useFocus,
  useRole,
  useDismiss,
  useInteractions,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
} from '@floating-ui/react'
import { useState } from 'react'
import { cn } from '../../lib/cn'

interface TooltipProps {
  content: string
  children: React.ReactNode
  /** Hover-open delay in ms. Default: 300. Focus-open is always 0. */
  delay?: number
  placement?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  disabled?: boolean
  /**
   * Allow the tooltip to wrap onto multiple lines instead of a single
   * `whitespace-nowrap` row. Use for sentence-length help text. Defaults to
   * `false` (single-line labels).
   */
  multiline?: boolean
}

export function Tooltip({
  content,
  children,
  delay = 300,
  placement = 'bottom',
  className,
  disabled = false,
  multiline = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 6 })],
  })

  const hover = useHover(context, { delay: { open: delay, close: 0 } })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  return (
    <>
      <span
        ref={refs.setReference}
        className={`inline-flex ${className ?? ''}`}
        {...getReferenceProps()}
      >
        {children}
      </span>
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          className={cn(
            'xj-tooltip border-border-default bg-elevated text-fg pointer-events-none z-(--z-tooltip) rounded-md border px-2 py-1 text-sm font-medium shadow-(--elev-3)',
            multiline ? 'max-w-56 text-xs leading-snug font-normal' : 'whitespace-nowrap',
            (!open || disabled) && 'hidden',
          )}
        >
          {content}
        </div>
      </FloatingPortal>
    </>
  )
}
