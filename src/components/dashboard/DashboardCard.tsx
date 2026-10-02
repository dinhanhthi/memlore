import { useContext, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { DASHBOARD_CARD_VISUALS } from '../../lib/dashboardCardVisuals'
import { VIZ_TONE } from '../stats/viz/vizTone'
import { DashboardCardIdContext } from './dashboardCardIdContext'

interface DashboardCardProps {
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function DashboardCard({ title, action, className, children }: DashboardCardProps) {
  const cardId = useContext(DashboardCardIdContext)
  const visuals = cardId != null ? DASHBOARD_CARD_VISUALS[cardId] : null
  const Icon = visuals?.icon
  const toneClass = visuals != null ? VIZ_TONE[visuals.tone] : null

  return (
    <div className={cn('card-glow flex h-full min-h-0 flex-col', className)}>
      <div className="card-glow-inner flex min-h-0 flex-1 flex-col p-3">
        <div className="flex shrink-0 flex-nowrap items-center justify-between gap-2">
          {Icon != null && toneClass != null ? (
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-lg',
                  toneClass.chipBg,
                  toneClass.text,
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </div>
              <h3 className="font-title text-fg min-w-0 truncate text-lg font-semibold tracking-tight">
                {title}
              </h3>
            </div>
          ) : (
            <h3 className="font-title text-fg min-w-0 truncate text-lg font-semibold tracking-tight">
              {title}
            </h3>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
