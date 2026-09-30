import { createContext } from 'react'
import type { DashboardCardId } from '../../lib/dashboardCards'

/** Card id for the grid cell that wraps a `DashboardCard`. Null outside the grid. */
export const DashboardCardIdContext = createContext<DashboardCardId | null>(null)
