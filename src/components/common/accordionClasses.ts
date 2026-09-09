import { cn } from '../../lib/cn'

/**
 * Providers-aligned accordion chrome (same tokens as Settings → AI → Providers):
 *   tab rest  → `bg-surface-hi`
 *   tab hover → `bg-surface-row-hover`
 *   body      → transparent (inherits the slide panel / parent surface)
 */
export const accordionShellClass = 'border-border-card overflow-hidden rounded-xl border'

export const accordionTabClass = cn(
  'flex w-full items-center justify-between gap-3 px-4 py-3 text-left',
  'bg-surface-hi text-fg text-sm font-normal outline-none',
  'hover:bg-surface-row-hover',
  'transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
  'motion-reduce:transition-none',
)

export const accordionBodyClass = 'bg-transparent px-4 py-3'

export const accordionDividerClass = 'border-border-default border-t'
