import React, { forwardRef, isValidElement, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrbState } from 'thinking-orbs'
import { cn } from '../../lib/cn'
import { announce } from '../../stores/announcerStore'
import { useUiStore } from '../../stores/uiStore'
import { AiIcon } from './AiIcon'
import { InlineOrb, ThinkingOrb } from './ThinkingOrb'

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'outline-secondary'
  | 'secondary-outline' // alias of outline-secondary
  | 'destructive'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: React.ReactNode
  children?: React.ReactNode
  /**
   * Renders the button in a "selected / pressed" state — used by toolbar
   * affordances (e.g. EditorFooter's AI / More buttons) to
   * signal "this popover is open". Currently only the `ghost` and
   * `outline` variants style this; other variants ignore the prop.
   * Distinct from the CSS `:active` pseudo-class which fires only while
   * the user is mid-click.
   */
  active?: boolean
  /**
   * Renders a spinning loader in place of `icon` and disables the button.
   * Use for action buttons that kick off an async operation and show an
   * "…ing" label while it runs (Revoking…, Saving…, Resuming…, etc.).
   */
  loading?: boolean
  /**
   * Thinking-orb animation used while `loading` is true.
   * Defaults to `searching`; AI “Thinking…” actions can pass `solving`.
   */
  loadingOrbState?: OrbState
  /**
   * When set, `loading` false→true announces the shared “Generating…”
   * string and a successful true→false announces this settle text.
   * Failures skip settle (errors use role=alert). Omit on non-AI buttons.
   */
  announceOnSettle?: string
  /** Skip the settle announcement — the loading cycle ended in failure. */
  loadingError?: boolean
}

/* Native-style control ladder on the 15px root: h-6.5/h-8/h-9/h-11 render
   at 24.375 / 30 / 33.75 / 41.25px. Icon-only buttons become squares via
   the width class of the same step. */
const sizeClass: Record<ButtonSize, string> = {
  xs: 'h-6.5 text-xs',
  sm: 'h-8 text-xs',
  md: 'h-9 text-sm',
  lg: 'h-11 text-base',
}
const sizePadClass: Record<ButtonSize, string> = {
  xs: 'px-2.5',
  sm: 'px-3',
  md: 'px-4',
  lg: 'px-5',
}
const sizeIconOnlyClass: Record<ButtonSize, string> = {
  xs: 'w-6.5',
  sm: 'w-8',
  md: 'w-9',
  lg: 'w-11',
}

/* Button radius — driven by the `--button-radius` CSS token so it
   automatically switches between pill (Signature) and rounded-md (Clean)
   with no runtime design-system read. Callers can still override with
   `className` (e.g. `rounded-none` link-style). */
const CAPSULE_RADIUS = 'rounded-(--button-radius)'

// Shared by `outline-secondary` and its alias `secondary-outline`.
// Same solid fill as `secondary`, plus a visible edge.
const OUTLINE_SECONDARY_CLASS = cn(
  'inline-flex cursor-pointer items-center gap-1.5',
  CAPSULE_RADIUS,
  'border border-border-default bg-surface-control font-medium text-fg shadow-(--shadow-control)',
  'hover:bg-surface-control-hover',
  'motion-safe:active:scale-[0.98] active:brightness-95',
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
)

const variantClass: Record<ButtonVariant, string> = {
  primary: cn(
    // AA-safe CTA sweep (`gradient-primary` → --grad-accent-fill).
    'gradient-primary',
    'inline-flex cursor-pointer items-center gap-2 border-none',
    CAPSULE_RADIUS,
    'font-semibold tracking-[-.1px] text-fg-inverse',
    'hover:brightness-[1.07] motion-safe:active:scale-[0.98] active:brightness-95',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:brightness-100 disabled:active:scale-100',
  ),
  secondary: cn(
    // SuperX secondary chip: solid mid-gray, never the same as card
    // (`surface-hi`) or row hover (`surface-row-hover`) so Connect/Config
    // stays readable in dense AI settings lists.
    'inline-flex cursor-pointer items-center gap-1.5 border-none',
    CAPSULE_RADIUS,
    'bg-surface-control text-fg shadow-(--shadow-control)',
    'hover:bg-surface-control-hover',
    'font-medium',
    'motion-safe:active:scale-[0.98] active:brightness-95',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
  ),
  ghost: cn(
    'inline-flex cursor-pointer items-center gap-1.5 border-none',
    CAPSULE_RADIUS,
    'font-medium text-fg-muted bg-transparent',
    'hover:bg-surface-hi hover:text-fg',
    'motion-safe:active:scale-[0.98] active:brightness-95',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
  ),
  // Ghost + border — shadcn-style outline: transparent fill, visible edge,
  // same hover lift as ghost. Use when a secondary action needs more weight
  // than ghost but less than secondary's solid chip.
  outline: cn(
    'inline-flex cursor-pointer items-center gap-1.5',
    CAPSULE_RADIUS,
    'border border-border-default bg-transparent font-medium text-fg-muted',
    'hover:bg-surface-hi hover:text-fg',
    'motion-safe:active:scale-[0.98] active:brightness-95',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
  ),
  // Secondary fill + border. `secondary-outline` is an alias (same classes).
  'outline-secondary': OUTLINE_SECONDARY_CLASS,
  'secondary-outline': OUTLINE_SECONDARY_CLASS,
  destructive: cn(
    'inline-flex cursor-pointer items-center gap-2',
    CAPSULE_RADIUS,
    'border border-danger/40 bg-transparent font-semibold text-danger-text',
    'hover:bg-danger/10 motion-safe:active:scale-[0.98] active:brightness-95',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
  ),
}

// Per-variant overlay applied when `active={true}`. `ghost` and `outline`
// share the accent pressed look (toolbar use-cases); other variants no-op
// so adding `active` to them stays safe.
const activeClass: Record<ButtonVariant, string> = {
  primary: '',
  secondary: '',
  ghost: 'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text',
  outline: 'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text',
  'outline-secondary': '',
  'secondary-outline': '',
  destructive: '',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    icon,
    children,
    className,
    type = 'button',
    style,
    active = false,
    loading = false,
    loadingOrbState = 'searching',
    announceOnSettle,
    loadingError = false,
    disabled,
    ...rest
  },
  ref,
) {
  const { t: tAi } = useTranslation('ai')
  const wasLoading = useRef(false)
  const startText = tAi('announcer.generating')
  useEffect(() => {
    if (!announceOnSettle) {
      wasLoading.current = loading
      return
    }
    if (loading && !wasLoading.current) {
      announce(startText)
    } else if (!loading && wasLoading.current && !loadingError) {
      announce(announceOnSettle)
    }
    wasLoading.current = loading
  }, [loading, announceOnSettle, loadingError, startText])

  // Loading replaces the leading icon with a thinking-orb (inline 20px)
  // preset; default `searching`). The orb auto-freezes under reduced motion.
  // The orb ignores CSS `color`/`text-*` — it resolves its own ink via the
  // app theme (the `.dark` class on <html>). Primary fills carry a white
  // label in every design system, so the orb is pinned to `theme="dark"`
  // (light ink) regardless of mode. Surface-tuned contrast filters live in
  // `ThinkingOrb`; on `theme="dark"` the `searching` state needs alpha
  // amplification rather than a brightness lift — see `searchingBoost`.
  // Clay dark labels are accent ink (dark) on a light fill, so the orb stays
  // on auto there.
  const designSystem = useUiStore((s) => s.designSystem)
  const theme = useUiStore((s) => s.theme)
  const primaryOrbTheme =
    variant === 'primary' && !(designSystem === 'clay' && theme === 'dark')
      ? ('dark' as const)
      : undefined
  const idleIcon =
    primaryOrbTheme != null &&
    isValidElement(icon) &&
    (icon.type === AiIcon || icon.type === InlineOrb || icon.type === ThinkingOrb)
      ? React.cloneElement(icon as React.ReactElement<{ theme?: string }>, {
          theme: primaryOrbTheme,
        })
      : icon
  const leadingIcon = loading ? (
    <InlineOrb state={loadingOrbState} theme={primaryOrbTheme} aria-hidden />
  ) : (
    idleIcon
  )
  const iconOnly = leadingIcon != null && children == null
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cn(
        variantClass[variant],
        sizeClass[size],
        iconOnly ? cn(sizeIconOnlyClass[size], 'justify-center p-0') : sizePadClass[size],
        active && activeClass[variant],
        className,
      )}
      style={{
        transition:
          'filter var(--button-motion), transform var(--button-motion), box-shadow var(--button-motion)',
        // A loading button is busy, not dimmed — the disabled state here only
        // exists to prevent double-clicks, so keep full opacity (inline style
        // wins over the `disabled:opacity-50` utility) so the loading orb and
        // label stay clearly visible. Genuinely-disabled (non-loading) buttons
        // still dim normally since `loading` is false.
        opacity: loading ? 1 : undefined,
        ...style,
      }}
      {...rest}
    >
      {leadingIcon}
      {children}
    </button>
  )
})
Button.displayName = 'Button'
