import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { VIZ_TONE, type VizTone } from './vizTone'

export interface StatTileProps {
  tone: VizTone
  icon: LucideIcon
  value: ReactNode
  label?: string
  action?: ReactNode
  children?: ReactNode
}

const NUMERAL =
  'font-title text-2xl leading-none font-semibold tabular-nums @min-[8rem]:text-3xl @min-[12rem]:text-4xl @min-[16rem]:text-5xl'

/**
 * Rounded elevated card for one story-in-numbers figure.
 * The numeral scales with the card width via container queries.
 */
export function StatTile({ tone, icon: Icon, value, label, action, children }: StatTileProps) {
  const toneClass = VIZ_TONE[tone]

  return (
    <div
      className={cn(
        'bg-elevated @container flex h-full min-w-0 flex-col gap-2 rounded-2xl p-3',
        'shadow-(--elev-2) hover:shadow-(--elev-3)',
        'motion-safe:transition-shadow motion-safe:duration-(--motion-duration-fast) motion-safe:ease-(--motion-ease-out-expo)',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl',
            toneClass.chipBg,
            toneClass.text,
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </div>
        {action != null ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={cn('min-w-0', NUMERAL, toneClass.text)}>{value}</div>
      {label != null && label !== '' ? (
        <p className="text-fg-muted truncate text-xs">{label}</p>
      ) : null}
      {children != null ? (
        <div className="flex min-h-10 w-full flex-1 flex-col">{children}</div>
      ) : null}
    </div>
  )
}
