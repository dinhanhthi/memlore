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
    <div
      className={cn(
        'dashboard-card-shell card-wave-edge h-full min-h-0 shadow-(--elev-2)',
        className,
      )}
    >
      <div className="dashboard-card-fill bg-elevated border-border-default card-wave-edge flex h-full min-h-0 flex-col gap-4 overflow-hidden border p-4">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          {Icon != null && toneClass != null ? (
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-xl',
                  toneClass.chipBg,
                  toneClass.text,
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </div>
              <h3 className="font-title text-fg text-xl font-semibold whitespace-nowrap">
                {title}
              </h3>
            </div>
          ) : (
            <h3 className="font-title text-fg text-lg font-semibold whitespace-nowrap">{title}</h3>
          )}
          {action && <div className="shrink-0 whitespace-nowrap">{action}</div>}
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  )
}
