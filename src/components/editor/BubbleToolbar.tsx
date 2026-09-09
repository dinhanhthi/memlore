import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

// Shared primitives for the editor's floating bubble toolbars
// (EditorBubbleMenu for text, ImageBubbleMenu for images). Extracted so the
// button styling, accessibility attributes, and the pointer arrow live in one
// place and can't drift between the two menus.

interface BubbleButtonProps {
  label: string
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}

/** Square icon button used inside a bubble toolbar. */
export function BubbleButton({ label, active, onClick, disabled, children }: BubbleButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-7 place-items-center rounded-lg border-none p-0',
        // pointer-events-none lets a wrapping <Tooltip> keep receiving hover
        // (browsers suppress mouse events on disabled buttons).
        disabled
          ? 'text-fg-muted pointer-events-none cursor-default opacity-50'
          : active
            ? 'text-accent-text cursor-pointer'
            : 'text-fg-secondary hover:text-fg cursor-pointer',
      )}
      style={{
        background: active ? 'var(--grad-accent-soft)' : 'transparent',
        transition: 'background var(--motion-fast)',
      }}
    >
      {children}
    </button>
  )
}

/** Text-label variant (e.g. the S / M / L size presets). */
export function TextBubbleButton({ label, active, onClick, children }: BubbleButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-lg border-none px-2 py-1 text-xs font-medium',
        active ? 'text-accent-text' : 'text-fg-secondary hover:text-fg',
      )}
      style={{
        background: active ? 'var(--grad-accent-soft)' : 'transparent',
        transition: 'background var(--motion-fast)',
      }}
    >
      {children}
    </button>
  )
}

/** Thin vertical divider between button groups. */
export function Separator() {
  return <span aria-hidden="true" className="bg-border-default mx-0.5 h-4 w-px" />
}

/** Downward pointer arrow anchored to the bottom-center of the toolbar. */
export function BubbleArrow() {
  return (
    <span
      aria-hidden="true"
      className="border-t-elevated absolute top-full left-1/2 h-0 w-0 -translate-x-1/2 border-t-[6px] border-r-[6px] border-l-[6px] border-solid border-r-transparent border-l-transparent"
    />
  )
}
