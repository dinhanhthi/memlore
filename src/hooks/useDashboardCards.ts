import {
  DEFAULT_DASHBOARD_CARDS,
  parseDashboardCards,
  serializeDashboardCards,
  type DashboardCardPref,
} from '../lib/dashboardCards'
import { createSettingHook } from './createSettingHook'

const setting = createSettingHook<DashboardCardPref[]>({
  key: 'dashboard_cards',
  defaultValue: DEFAULT_DASHBOARD_CARDS,
  parse: parseDashboardCards,
  serialize: serializeDashboardCards,
  logLabel: 'useDashboardCards',
  ignoreHydrateAfterUserWrite: true,
})

/**
 * Read `dashboard_cards` from SQLite. Called after DB unlock so the
 * setting reflects the real database, not the `:memory:` placeholder.
 */
export const hydrateDashboardCards = setting.hydrate

export function useDashboardCards(): DashboardCardPref[] {
  return setting.useValue()
}

export const getDashboardCards = setting.get

/** Imperative setter — for customize UI and non-React callers. */
export const setDashboardCards = setting.setValue

/** Test-only: reset module state between cases. */
export const __resetDashboardCardsForTests = setting.reset
