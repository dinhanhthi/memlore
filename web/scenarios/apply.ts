import { setActiveScenario } from '../mocks/activeScenario'
import { __emit } from '../mocks/event'
import { markLaunchViewApplied } from '../../src/stores/tabStore'
import { getScenario, defaultScenarioId, scenarios } from './index'
import { resetPreviewState } from './resetPreviewState'

export const STORAGE_KEY = 'xj-web-scenario'

export function applyScenario(id: string, remount: () => void): string {
  // Before seedStores: once App.tsx wires applyLaunchView, harness
  // scenarios must keep the view they seed (not flip to dashboard).
  markLaunchViewApplied()
  const scenario = getScenario(id) ?? getScenario(defaultScenarioId) ?? scenarios[0]
  if (!scenario) return id
  resetPreviewState()
  setActiveScenario(scenario)
  scenario.seedStores?.()
  const emits =
    typeof scenario.emitOnLoad === 'function' ? scenario.emitOnLoad() : scenario.emitOnLoad
  if (emits) {
    for (const { event, payload, delayMs } of emits) {
      if (delayMs != null && delayMs > 0) {
        setTimeout(() => __emit(event, payload), delayMs)
      } else {
        __emit(event, payload)
      }
    }
  }
  localStorage.setItem(STORAGE_KEY, scenario.id)
  remount()
  // Post-mount DOM actions (e.g. expand Sync help) need a tick after React paint.
  if (scenario.afterMount) {
    const run = scenario.afterMount
    setTimeout(() => run(), 0)
  }
  return scenario.id
}
