import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface DashboardCardProps {
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export function DashboardCard({ title, action, className, children }: DashboardCardProps) {
  return (
    <div
      className={cn(
        'dashboard-card-shell card-wave-edge h-full min-h-0 shadow-(--elev-2)',
        className,
      )}
    >
      <div className="dashboard-card-fill bg-elevated border-border-default card-wave-edge flex h-full min-h-0 flex-col gap-4 overflow-hidden border p-4">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h3 className="font-title text-fg text-lg font-semibold whitespace-nowrap">{title}</h3>
          {action && <div className="shrink-0 whitespace-nowrap">{action}</div>}
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  )
}
