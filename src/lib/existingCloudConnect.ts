import type { CloudProviderKind, GdriveConnectOutcome } from './tauri'

/** How WelcomeScreen should start an "I already have a journal" connect. */
export type ExistingCloudConnectPlan =
  | { kind: 'gdrive' }
  | { kind: 'folder'; provider: 'icloud' | 'local'; rootPath: string }
  | { kind: 'folder_required' }

/** Next screen / side-effect after an Unset-mode connect outcome. */
export type UnsetConnectRoute =
  | { action: 'onboard-existing' }
  | { action: 'cloud-empty-prompt' }
  | { action: 'force-re-pair'; reason: string }
  | { action: 'error'; key: 'v1_wiped' | 'unexpected_ready' | 'generic' }

/**
 * Decide OAuth vs folder connect vs a local-folder validation error.
 * iCloud does not need a user-picked path — the backend resolves the root.
 */
export function planExistingCloudConnect(
  provider: CloudProviderKind,
  rootPath: string | null | undefined,
): ExistingCloudConnectPlan {
  if (provider === 'gdrive') return { kind: 'gdrive' }
  if (provider === 'local' && !rootPath) return { kind: 'folder_required' }
  return { kind: 'folder', provider, rootPath: rootPath ?? '' }
}

/** Same outcome switch WelcomeScreen used for Drive OAuth — now provider-agnostic. */
export function routeUnsetConnectOutcome(outcome: GdriveConnectOutcome): UnsetConnectRoute {
  switch (outcome.outcome) {
    case 'needs_onboarding':
      return { action: 'onboard-existing' }
    case 'needs_first_time_setup':
      return { action: 'cloud-empty-prompt' }
    case 'needs_force_re_pair':
      return { action: 'force-re-pair', reason: outcome.reason }
    case 'v1_wiped_reconnect_required':
      return { action: 'error', key: 'v1_wiped' }
    case 'ready':
      return { action: 'error', key: 'unexpected_ready' }
    default:
      return { action: 'error', key: 'generic' }
  }
}

/** Cancel is OAuth-only — folder connect never waits on a browser callback. */
export function shouldShowExistingCloudCancel(
  provider: CloudProviderKind,
  isAwaitingCallback: boolean,
): boolean {
  return provider === 'gdrive' && isAwaitingCallback
}
