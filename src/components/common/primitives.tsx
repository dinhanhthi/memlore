import React, { forwardRef } from 'react'
import type { Tag } from '../../types/journal'
import { cn } from '../../lib/cn'

// ─── SVG star color constant ───────────────────────────────────────────────────
// SVG fill cannot consume CSS custom properties (var(--*)) reliably in WKWebView.
// Graphite redesign: single warm gold for the active/favorited state (no gradient).
// Mirrors oklch(80% 0.15 90) ≈ #F5B942. If the gold token changes, update here too.
const FAVORITE_GOLD = '#F5B942' as const

// ─── Pill size classes ────────────────────────────────────────────────────────

const pillSizeClasses = {
  sm: 'h-6 px-2 text-2xs gap-1',
  md: 'h-7 px-2.5 text-xs gap-1.5',
} as const

// ─── Pill selected / unselected class sets ────────────────────────────────────

// SuperX filter pills: full radius, surface + strong border idle; accent-soft active.
const pillSelected = 'bg-accent-soft border-accent/40 text-accent-text'
const pillUnselected =
  'bg-elevated border-border-default text-fg-muted hover:text-fg hover:bg-surface-hi'

// ─── Size maps ────────────────────────────────────────────────────────────────

const inputSizes = {
  sm: { h: 32, fs: 13 },
  md: { h: 40, fs: 14 },
  lg: { h: 48, fs: 15 },
}

const tagPillSizes = {
  sm: { h: 20, px: 7, fs: 11 },
  md: { h: 24, px: 9, fs: 12 },
}

// ─── Pill ─────────────────────────────────────────────────────────────────────

interface PillProps {
  icon?: React.ReactNode
  color?: string
  children: React.ReactNode
  selected?: boolean
  size?: 'sm' | 'md'
  onClick?: () => void
  className?: string
  /** Forwarded to the underlying button — needed for menu/dialog triggers. */
  'aria-label'?: string
  'aria-haspopup'?: React.AriaAttributes['aria-haspopup']
  'aria-expanded'?: boolean
  'aria-controls'?: string
}

export const Pill = forwardRef<HTMLButtonElement, PillProps>(function Pill(
  {
    icon,
    color,
    children,
    selected,
    size = 'md',
    onClick,
    className = '',
    'aria-label': ariaLabel,
    'aria-haspopup': ariaHasPopup,
    'aria-expanded': ariaExpanded,
    'aria-controls': ariaControls,
  },
  ref,
) {
  const baseClass = cn(
    'inline-flex items-center rounded-full whitespace-nowrap font-mono border transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
    pillSizeClasses[size],
    selected ? pillSelected : pillUnselected,
    className,
  )

  const colorDot = color ? (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
  ) : null

  if (onClick) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-haspopup={ariaHasPopup}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        className={cn('cursor-pointer', baseClass)}
      >
        {colorDot}
        {icon}
        {children}
      </button>
    )
  }

  return (
    // Ref not forwarded in span-mode (consumers using ref intend to focus() which requires button mode)
    <span className={cn('cursor-default', baseClass)} aria-label={ariaLabel}>
      {colorDot}
      {icon}
      {children}
    </span>
  )
})
Pill.displayName = 'Pill'

// ─── Input ────────────────────────────────────────────────────────────────────

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  icon?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, size = 'md', ...rest },
  ref,
) {
  const s = inputSizes[size]
  return (
    <div
      className="border-border-default bg-elevated focus-within:border-accent relative flex items-center rounded-xl border px-3 transition-[border-color,box-shadow] duration-(--motion-duration-fast) focus-within:shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_30%,transparent)]"
      style={{ height: s.h }}
    >
      {icon && <span className="text-fg-faint mr-2 flex">{icon}</span>}
      <input
        ref={ref}
        className="xj-input-bare text-fg placeholder:text-fg-faint h-full flex-1 border-none bg-transparent outline-none"
        style={{ fontSize: s.fs }}
        {...rest}
      />
    </div>
  )
})
Input.displayName = 'Input'

// ─── Star ─────────────────────────────────────────────────────────────────────

interface StarProps {
  active?: boolean
  size?: number
  onClick?: () => void
  className?: string
  label?: string
}

export const Star = forwardRef<HTMLButtonElement, StarProps>(function Star(
  { active, size = 16, onClick, className, label },
  ref,
) {
  const svg = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={cn('text-fg-faint block shrink-0', className)}
      aria-hidden="true"
    >
      <path
        d="M10 3l2.06 4.17 4.6.67-3.33 3.25.79 4.58L10 13.5l-4.12 2.17.79-4.58L3.34 7.84l4.6-.67L10 3Z"
        fill={active ? FAVORITE_GOLD : 'none'}
        stroke={active ? 'transparent' : 'currentColor'}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )

  if (onClick) {
    const defaultLabel = active ? 'Remove from favorites' : 'Add to favorites'
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={label ?? defaultLabel}
        className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0"
      >
        {svg}
      </button>
    )
  }

  return svg
})
Star.displayName = 'Star'

// ─── Kbd ──────────────────────────────────────────────────────────────────────

interface KbdProps {
  children: React.ReactNode
}

export function Kbd({ children }: KbdProps) {
  return (
    <kbd className="border-border-default bg-surface-hi text-fg-muted text-2xs inline-flex min-w-[1.4em] items-center justify-center rounded-md border border-b-2 px-1.5 py-0.5 font-mono font-medium">
      {children}
    </kbd>
  )
}

// ─── Glass ────────────────────────────────────────────────────────────────────

type GlassRadius = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const GLASS_RADIUS_CLASSES: Record<GlassRadius, string> = {
  xs: 'rounded-lg',
  sm: 'rounded-xl',
  md: 'rounded-2xl',
  lg: 'rounded-2xl',
  xl: 'rounded-2xl',
}

interface GlassProps {
  variant?: 'default' | 'strong' | 'subtle'
  radius?: GlassRadius
  className?: string
  children: React.ReactNode
}

export function Glass({
  variant = 'default',
  radius = 'md',
  className = '',
  children,
}: GlassProps) {
  // Graphite design system: solid surfaces, hairline borders, no glass blur.
  // Three-step elevation ladder (subtle → default → strong) using the static
  // surface tokens instead of the old translucent `bg-elevated/NN` + backdrop.
  const variantClass =
    variant === 'strong' ? 'bg-elevated' : variant === 'subtle' ? 'bg-panel-1' : 'bg-surface-hi'
  return (
    <div
      className={`${variantClass} border-border-default border ${GLASS_RADIUS_CLASSES[radius]} ${className}`}
    >
      {children}
    </div>
  )
}

// ─── IconButton ───────────────────────────────────────────────────────────────

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        // SuperX icon button: 10px radius, muted idle, surface-hi hover.
        'text-fg-muted hover:bg-surface-hi hover:text-fg grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[10px] border-none bg-transparent transition-[background-color,color] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
        'disabled:hover:text-fg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
IconButton.displayName = 'IconButton'

// ─── TagPill ──────────────────────────────────────────────────────────────────

interface TagPillProps {
  tag: Tag
  onClick?: () => void
  size?: 'sm' | 'md'
}

export const TagPill = forwardRef<HTMLButtonElement, TagPillProps>(function TagPill(
  { tag, onClick, size = 'sm' },
  ref,
) {
  const s = tagPillSizes[size]

  // Dev-time guard: warn if color is not a hex string or null
  if (process.env.NODE_ENV !== 'production' && tag.color !== null && !tag.color.startsWith('#')) {
    console.warn(`TagPill expects hex color or null; got: ${tag.color}`)
  }

  // Layout only — no color/bg/border; those come from Tailwind tokens.
  const layoutStyle: React.CSSProperties = {
    height: s.h,
    padding: `0 ${s.px}px`,
    fontSize: s.fs,
  }

  // Dot: per-tag color if set, otherwise a neutral faint dot via className.
  const dot =
    tag.color !== null ? (
      <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: tag.color }} />
    ) : (
      <span className="bg-fg-faint h-1 w-1 shrink-0 rounded-full" />
    )

  const containerClass =
    'inline-flex items-center gap-1 rounded-lg font-mono whitespace-nowrap border border-border-default bg-surface-hi text-fg-muted'

  if (onClick) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        style={layoutStyle}
        className={`${containerClass} hover:border-border-subtle hover:text-fg-secondary cursor-pointer`}
      >
        {dot}
        {tag.name}
      </button>
    )
  }

  return (
    // Ref not forwarded in span-mode (consumers using ref intend to focus() which requires button mode)
    <span style={layoutStyle} className={`${containerClass} cursor-default`}>
      {dot}
      {tag.name}
    </span>
  )
})
TagPill.displayName = 'TagPill'
