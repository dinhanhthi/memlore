export type SecureWizardStep =
  | 'triage'
  | 'words_leaked'
  | 'reset_confirm'
  | 'reset_running'
  | 'reset_done'
  | 'password_leaked'
  | 'password_change'
  | 'device_pick'
  | 'device_words'
  | 'device_scope'
  | 'revoke_confirm'
  | 'revoke_running'
  | 'revoke_done'
  | 'remove_confirm'
  | 'remove_running'
  | 'remove_done'
  | 'cutoff_1'
  | 'cutoff_2'
  | 'cutoff_3'
  | 'cutoff_done'
  | 'routine_intro'
  | 'routine_confirm'
  | 'routine_running'
  | 'routine_done'

export type SecureWizardChoice =
  | 'words_leaked'
  | 'password_leaked'
  | 'device_compromised'
  | 'routine_rotation'
  | 'device_reached'
  | 'device_not_reached'
  | 'phrase_leaked'
  | 'phrase_safe'
  | 'revoke_only'
  | 'just_remove'
  | 'cutoff_google'
  | 'next'
  | 'rotate_key'

export type SecureWizardState = {
  step: SecureWizardStep
  targetDevice: { id: string; name: string } | null
  needsPhraseReset: boolean
  seeded: boolean
  cutoffEnteredLate: boolean
}

export type SecureWizardStepCounter = {
  current: number
  total: number
}

export function createInitialSecureWizardState(): SecureWizardState {
  return {
    step: 'triage',
    targetDevice: null,
    needsPhraseReset: false,
    seeded: false,
    cutoffEnteredLate: false,
  }
}

function moveTo(state: SecureWizardState, step: SecureWizardStep): SecureWizardState {
  return { ...state, step }
}

export function nextStep(state: SecureWizardState, choice: SecureWizardChoice): SecureWizardState {
  switch (state.step) {
    case 'triage':
      if (choice === 'words_leaked') return moveTo(state, 'words_leaked')
      if (choice === 'password_leaked') return moveTo(state, 'password_leaked')
      if (choice === 'device_compromised') {
        return moveTo(state, state.seeded ? 'device_words' : 'device_pick')
      }
      if (choice === 'routine_rotation') return moveTo(state, 'routine_intro')
      return state

    case 'words_leaked':
      return choice === 'next' ? moveTo(state, 'reset_confirm') : state
    case 'reset_confirm':
      return choice === 'next' ? moveTo(state, 'reset_running') : state
    case 'reset_running':
      return choice === 'next' ? moveTo(state, 'reset_done') : state

    case 'password_leaked':
      if (choice === 'device_reached') {
        return moveTo(state, state.seeded ? 'device_words' : 'device_pick')
      }
      return choice === 'device_not_reached' ? moveTo(state, 'password_change') : state
    case 'password_change':
      return choice === 'rotate_key' ? moveTo(state, 'routine_confirm') : state

    case 'device_pick':
      return choice === 'next' ? moveTo(state, 'device_words') : state
    case 'device_words':
      if (choice === 'phrase_leaked') {
        return { ...state, step: 'device_scope', needsPhraseReset: true }
      }
      if (choice === 'phrase_safe') {
        return { ...state, step: 'device_scope', needsPhraseReset: false }
      }
      if (choice === 'just_remove') {
        // "Nothing happened" supersedes an earlier phrase_leaked answer the
        // user may have backed out of — the tidy-up path must not chain into
        // the recovery-word reset after remove_done.
        return { ...state, step: 'remove_confirm', needsPhraseReset: false }
      }
      return state
    case 'device_scope':
      if (choice === 'revoke_only') return moveTo(state, 'revoke_confirm')
      if (choice === 'cutoff_google') {
        return { ...state, step: 'cutoff_1', cutoffEnteredLate: false }
      }
      return state
    case 'revoke_confirm':
      return choice === 'next' ? moveTo(state, 'revoke_running') : state
    case 'revoke_running':
      return choice === 'next' ? moveTo(state, 'revoke_done') : state
    case 'revoke_done':
      if (state.needsPhraseReset && choice === 'next') {
        return moveTo(state, 'words_leaked')
      }
      if (!state.needsPhraseReset && choice === 'cutoff_google') {
        return { ...state, step: 'cutoff_2', cutoffEnteredLate: true }
      }
      return state

    case 'remove_confirm':
      return choice === 'next' ? moveTo(state, 'remove_running') : state
    case 'remove_running':
      return choice === 'next' ? moveTo(state, 'remove_done') : state

    case 'cutoff_1':
      return choice === 'next' ? moveTo(state, 'cutoff_2') : state
    case 'cutoff_2':
      return choice === 'next' ? moveTo(state, 'cutoff_3') : state
    case 'cutoff_3':
      return choice === 'next' ? moveTo(state, 'cutoff_done') : state
    case 'cutoff_done':
      return state.needsPhraseReset && choice === 'next' ? moveTo(state, 'words_leaked') : state

    case 'routine_intro':
      return choice === 'next' ? moveTo(state, 'routine_confirm') : state
    case 'routine_confirm':
      return choice === 'next' ? moveTo(state, 'routine_running') : state
    case 'routine_running':
      return choice === 'next' ? moveTo(state, 'routine_done') : state

    case 'reset_done':
    case 'routine_done':
    case 'remove_done':
      return state
  }
}

export function prevStep(state: SecureWizardState): SecureWizardState {
  switch (state.step) {
    case 'triage':
      return state
    case 'words_leaked':
      return moveTo(state, 'triage')
    case 'reset_confirm':
      return moveTo(state, 'words_leaked')
    case 'reset_running':
      return moveTo(state, 'reset_confirm')
    case 'reset_done':
      return state
    case 'password_leaked':
      return moveTo(state, 'triage')
    case 'password_change':
      return moveTo(state, 'password_leaked')
    case 'device_pick':
      return moveTo(state, 'triage')
    case 'device_words':
      return state.seeded ? state : moveTo(state, 'device_pick')
    case 'device_scope':
      return moveTo(state, 'device_words')
    case 'revoke_confirm':
      return moveTo(state, 'device_scope')
    case 'revoke_running':
      return moveTo(state, 'revoke_confirm')
    case 'revoke_done':
      return state
    case 'remove_confirm':
      return moveTo(state, 'device_words')
    case 'remove_running':
      return moveTo(state, 'remove_confirm')
    case 'remove_done':
      return state
    case 'cutoff_1':
      return moveTo(state, 'device_scope')
    case 'cutoff_2':
      return moveTo(state, state.cutoffEnteredLate ? 'revoke_done' : 'device_scope')
    case 'cutoff_3':
      return moveTo(state, 'cutoff_2')
    case 'cutoff_done':
      return state
    case 'routine_intro':
      return moveTo(state, 'triage')
    case 'routine_confirm':
      return moveTo(state, 'routine_intro')
    case 'routine_running':
      return moveTo(state, 'routine_confirm')
    case 'routine_done':
      return state
  }
}

export function stepCounter(state: SecureWizardState): SecureWizardStepCounter | null {
  if (state.cutoffEnteredLate) {
    if (state.step === 'cutoff_2') return { current: 1, total: 2 }
    if (state.step === 'cutoff_3') return { current: 2, total: 2 }
    return null
  }

  if (state.step === 'cutoff_1') return { current: 1, total: 3 }
  if (state.step === 'cutoff_2') return { current: 2, total: 3 }
  if (state.step === 'cutoff_3') return { current: 3, total: 3 }
  return null
}
