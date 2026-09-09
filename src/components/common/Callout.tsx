import type { HTMLAttributes, ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { cn } from '../../lib/cn'

export type CalloutTone = 'warning' | 'success' | 'danger' | 'info'

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Semantic tone — drives background, border, and icon colour. */
  tone: CalloutTone
  /** Optional heading. When set, children render as supporting body text. */
  title?: ReactNode
  /** Body copy, lists, or extra notes. */
  children?: ReactNode
  /** Optional CTA (usually a small `<Button>`). Sits to the right unless `flush`. */
  action?: ReactNode
  /**
   * Override the default tone icon, or pass `false` to hide it.
   * Defaults: warning `AlertTriangle`, danger `AlertCircle`,
   * success `CheckCircle2`, info `Info`.
   */
  icon?: ReactNode | false
  /**
   * Edge-to-edge strip — no border, no radius. Used for full-width bands
   * inside a list or panel (e.g. the chat session gate).
   */
  flush?: boolean
  /** Compact padding + always-xs type. Default `md`. */
  size?: 'sm' | 'md'
}

const TONE_SURFACE: Record<CalloutTone, string> = {
  warning: 'border-warning-border bg-warning-bg',
  success: 'border-success/25 bg-success/8 dark:bg-success/20',
  danger: 'border-danger-border bg-danger-bg',
  info: 'border-info/25 bg-info/8 dark:bg-info/20',
}

const TONE_ICON: Record<CalloutTone, string> = {
  warning: 'text-warning-fg',
  success: 'text-success',
  danger: 'text-danger-fg',
  info: 'text-info',
}

/** Ink on the box. Warning / danger use the solid *-fg token so dark
 *  `text-fg` (near-white) never sits on the bright yellow / rose paper. */
const TONE_INK: Record<CalloutTone, string | null> = {
  warning: 'text-warning-fg',
  success: null,
  danger: 'text-danger-fg',
  info: null,
}

const DEFAULT_ICON = {
  warning: AlertTriangle,
  success: CheckCircle2,
  danger: AlertCircle,
  info: Info,
} as const

/**
 * Tinted status box shared by settings, chat, auth, and wizards.
 *
 * Warning / danger use solid `*-bg` / `*-border` / `*-fg` tokens (no alpha
 * wash). Success / info keep the tinted wash. Change colours or spacing
 * here — callers should not re-declare `bg-warning/…` themselves.
 */
export function Callout({
  tone,
  title,
  children,
  action,
  icon,
  flush = false,
  size = 'md',
  className,
  role,
  ...rest
}: CalloutProps) {
  const Icon = DEFAULT_ICON[tone]
  const showIcon = icon !== false
  const compact = size === 'sm'
  const hasTitle = title != null && title !== false && title !== ''
  const hasBody = children != null && children !== false && children !== ''
  const alignIconWithTitle = hasTitle && hasBody
  const resolvedIcon =
    icon === undefined || icon === false ? (
      <Icon
        className={cn(
          TONE_ICON[tone],
          'shrink-0',
          compact ? 'size-3.5' : 'size-4',
          alignIconWithTitle && 'mt-0.5',
        )}
        strokeWidth={1.75}
        aria-hidden
      />
    ) : (
      icon
    )

  const ink = TONE_INK[tone]
  const bodyClass = cn(
    'leading-snug',
    hasTitle || compact ? 'text-xs' : 'text-sm',
    ink ?? (hasTitle || compact ? 'text-fg-muted' : 'text-fg'),
  )

  const body =
    children == null ? null : typeof children === 'string' || typeof children === 'number' ? (
      <p className={cn(hasTitle && 'mt-0.5', bodyClass)}>{children}</p>
    ) : (
      <div className={cn(hasTitle && 'mt-0.5', bodyClass)}>{children}</div>
    )

  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cn(
        TONE_SURFACE[tone],
        flush
          ? 'flex flex-col gap-2 p-4'
          : cn(
              'flex rounded-sm border',
              compact ? 'px-2.5 py-2' : 'px-3.5 py-2.5',
              action ? 'flex-wrap items-center justify-between gap-3' : 'items-start gap-2.5',
            ),
        className,
      )}
      {...rest}
    >
      <div
        className={cn('flex min-w-0 gap-2.5', alignIconWithTitle ? 'items-start' : 'items-center')}
      >
        {showIcon && resolvedIcon}
        <div className="min-w-0">
          {hasTitle && (
            <p className={cn(ink ?? 'text-fg', 'text-sm leading-snug font-medium')}>{title}</p>
          )}
          {body}
        </div>
      </div>
      {action != null && <div className="shrink-0">{action}</div>}
    </div>
  )
}
