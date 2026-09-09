import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

/**
 * SuperX surface used by AI settings card groups:
 * surface-hi body (distinct from page canvas), card-edge border, 16px radius.
 * `--shadow-card` is none outside Clay. Row hover uses `surface-row-hover`.
 */
export const SETTINGS_SURFACE_CARD =
  'border-border-card overflow-hidden rounded-2xl border shadow-(--shadow-card)'

interface SettingsSurfaceCardProps {
  children: ReactNode
  className?: string
  /**
   * When true, children are separated by a strong hairline (`divide-border-default`).
   * Each child should supply its own horizontal padding (typically `px-4`).
   */
  divided?: boolean
}

/** Bare charcoal surface card — body for a settings group. */
export function SettingsSurfaceCard({
  children,
  className,
  divided = false,
}: SettingsSurfaceCardProps) {
  return (
    <section className="rounded-2xl shadow-(--shadow-card)">
      <div className={cn(SETTINGS_SURFACE_CARD, 'shadow-none', className)}>
        {divided ? <div className="divide-border-default divide-y">{children}</div> : children}
      </div>
    </section>
  )
}

interface SettingsGroupProps {
  /** Optional section label rendered *outside* the surface card. */
  title?: string
  /** Optional muted description under the title (never a "?" tooltip). */
  tip?: string
  /** Optional control on the title row (e.g. an add button). */
  titleAccessory?: ReactNode
  children: ReactNode
  /**
   * Separate children with strong hairline dividers. Default `true` — list
   * groups of `SettingsRow` / toggle rows. Set `false` for free-form card body
   * content (pass `className` on the card via `cardClassName` for padding).
   */
  divided?: boolean
  className?: string
  cardClassName?: string
}

/**
 * Settings section matching AI Features / Providers card groups:
 * optional label above, charcoal surface card below.
 */
export function SettingsGroup({
  title,
  tip,
  titleAccessory,
  children,
  divided = true,
  className,
  cardClassName,
}: SettingsGroupProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {(title != null || tip != null || titleAccessory != null) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title != null && <h3 className="text-fg text-sm font-semibold">{title}</h3>}
            {tip != null && <p className="text-fg-muted text-xs leading-snug">{tip}</p>}
          </div>
          {titleAccessory}
        </div>
      )}
      <SettingsSurfaceCard divided={divided} className={cardClassName}>
        {children}
      </SettingsSurfaceCard>
    </div>
  )
}
