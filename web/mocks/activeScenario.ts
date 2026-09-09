import type { ScenarioPreview } from '../scenarios/types'

// Active scenario invoke overrides and event seeding.
// A scenario object has: invoke?: Record<string, unknown | ((args: unknown) => unknown)>
// The router reads this to override defaults.
export interface ActiveScenario {
  id: string
  invoke?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>
  emitOnLoad?:
    | Array<{ event: string; payload: unknown; delayMs?: number }>
    | (() => Array<{ event: string; payload: unknown; delayMs?: number }>)
  seedStores?: () => void
  preview?: ScenarioPreview
}

let _active: ActiveScenario = {
  id: 'locked',
  invoke: {
    get_encryption_mode: 'password',
    is_encryption_initialized: false,
    get_force_re_pair_status: null,
    get_pending_rotation_recovery: null,
    get_pending_first_time_setup: null,
    get_sync_status: { enabled: false, provider: null, lastSync: null, entriesPending: 0 },
    get_sync_settings: { intervalMinutes: 0, onSave: false, onLaunch: false },
  },
}

export function getActiveScenario(): ActiveScenario {
  return _active
}

export function setActiveScenario(s: ActiveScenario): void {
  _active = s
}
