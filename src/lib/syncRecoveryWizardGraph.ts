export type SyncRecoveryWizardStep =
  | 'triage'
  | 'reset_confirm'
  | 'reset_running'
  | 'reset_done'
  | 'cloud_to_local_confirm'
  | 'local_to_cloud_confirm'
  | 'stop_choice'
  | 'disconnect_confirm'
  | 'disconnect_running'
  | 'disconnect_done'
  | 'delete_confirm'
  | 'delete_running'
  | 'delete_done'

export type SyncRecoveryWizardChoice =
  | 'sync_stuck'
  | 'device_wrong'
  | 'cloud_wrong'
  | 'stop_syncing'
  | 'keep_cloud'
  | 'delete_cloud'
  | 'next'

export type SyncRecoveryWizardState = {
  step: SyncRecoveryWizardStep
}

export function createInitialSyncRecoveryWizardState(): SyncRecoveryWizardState {
  return { step: 'triage' }
}

function moveTo(
  state: SyncRecoveryWizardState,
  step: SyncRecoveryWizardStep,
): SyncRecoveryWizardState {
  return { ...state, step }
}

export function nextStep(
  state: SyncRecoveryWizardState,
  choice: SyncRecoveryWizardChoice,
): SyncRecoveryWizardState {
  switch (state.step) {
    case 'triage':
      if (choice === 'sync_stuck') return moveTo(state, 'reset_confirm')
      if (choice === 'device_wrong') return moveTo(state, 'cloud_to_local_confirm')
      if (choice === 'cloud_wrong') return moveTo(state, 'local_to_cloud_confirm')
      if (choice === 'stop_syncing') return moveTo(state, 'stop_choice')
      return state

    case 'reset_confirm':
      return choice === 'next' ? moveTo(state, 'reset_running') : state
    case 'reset_running':
      return choice === 'next' ? moveTo(state, 'reset_done') : state

    case 'stop_choice':
      if (choice === 'keep_cloud') return moveTo(state, 'disconnect_confirm')
      if (choice === 'delete_cloud') return moveTo(state, 'delete_confirm')
      return state

    case 'disconnect_confirm':
      return choice === 'next' ? moveTo(state, 'disconnect_running') : state
    case 'disconnect_running':
      return choice === 'next' ? moveTo(state, 'disconnect_done') : state

    case 'delete_confirm':
      return choice === 'next' ? moveTo(state, 'delete_running') : state
    case 'delete_running':
      return choice === 'next' ? moveTo(state, 'delete_done') : state

    case 'cloud_to_local_confirm':
    case 'local_to_cloud_confirm':
    case 'reset_done':
    case 'disconnect_done':
    case 'delete_done':
      return state
    default: {
      // Exhaustiveness guard — adding a SyncRecoveryWizardStep must update this switch.
      const _exhaustive: never = state.step
      return _exhaustive
    }
  }
}

export function prevStep(state: SyncRecoveryWizardState): SyncRecoveryWizardState {
  switch (state.step) {
    case 'triage':
      return state
    case 'reset_confirm':
      return moveTo(state, 'triage')
    case 'reset_running':
      return moveTo(state, 'reset_confirm')
    case 'reset_done':
      return state
    case 'cloud_to_local_confirm':
      return moveTo(state, 'triage')
    case 'local_to_cloud_confirm':
      return moveTo(state, 'triage')
    case 'stop_choice':
      return moveTo(state, 'triage')
    case 'disconnect_confirm':
      return moveTo(state, 'stop_choice')
    case 'disconnect_running':
      return moveTo(state, 'disconnect_confirm')
    case 'disconnect_done':
      return state
    case 'delete_confirm':
      return moveTo(state, 'stop_choice')
    case 'delete_running':
      return moveTo(state, 'delete_confirm')
    case 'delete_done':
      return state
    default: {
      // Exhaustiveness guard — adding a SyncRecoveryWizardStep must update this switch.
      const _exhaustive: never = state.step
      return _exhaustive
    }
  }
}
