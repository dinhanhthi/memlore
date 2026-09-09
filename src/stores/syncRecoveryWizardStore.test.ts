import { beforeEach, describe, expect, it } from 'vitest'
import { useSyncRecoveryWizardStore } from './syncRecoveryWizardStore'

beforeEach(() => {
  useSyncRecoveryWizardStore.getState().setStepStatus('idle')
  useSyncRecoveryWizardStore.getState().close()
})

describe('syncRecoveryWizardStore', () => {
  it('opens the wizard at triage with a clean session', () => {
    useSyncRecoveryWizardStore.getState().openWizard()

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.open).toBe(true)
    expect(store.state.step).toBe('triage')
    expect(store.stepStatus).toBe('idle')
    expect(store.error).toBeNull()
  })

  it('fully resets the session when closed', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().setStepStatus('error', 'gdrive.help.recovery.error')

    useSyncRecoveryWizardStore.getState().close()

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.open).toBe(false)
    expect(store.state.step).toBe('triage')
    expect(store.stepStatus).toBe('idle')
    expect(store.error).toBeNull()
  })

  it('resets to a fresh session when opened again after a prior run', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().close()

    useSyncRecoveryWizardStore.getState().openWizard()

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.state.step).toBe('triage')
  })

  it('delegates forward navigation to the wizard graph', () => {
    useSyncRecoveryWizardStore.getState().openWizard()

    useSyncRecoveryWizardStore.getState().choose('sync_stuck')

    expect(useSyncRecoveryWizardStore.getState().state.step).toBe('reset_confirm')
  })

  it('delegates backward navigation to the wizard graph', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')

    useSyncRecoveryWizardStore.getState().back()

    expect(useSyncRecoveryWizardStore.getState().state.step).toBe('triage')
  })

  it('clears stepStatus and error when choosing', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().setStepStatus('error', 'some error')

    useSyncRecoveryWizardStore.getState().choose('sync_stuck')

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.stepStatus).toBe('idle')
    expect(store.error).toBeNull()
  })

  it('clears stepStatus and error when going back', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().setStepStatus('error', 'some error')

    useSyncRecoveryWizardStore.getState().back()

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.stepStatus).toBe('idle')
    expect(store.error).toBeNull()
  })

  it('ignores openWizard while a step is running', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().choose('next')
    useSyncRecoveryWizardStore.getState().setStepStatus('running')

    useSyncRecoveryWizardStore.getState().openWizard()

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.state.step).toBe('reset_running')
    expect(store.stepStatus).toBe('running')
  })

  it('ignores close while a step is running', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().choose('next')
    useSyncRecoveryWizardStore.getState().setStepStatus('running')

    useSyncRecoveryWizardStore.getState().close()

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.open).toBe(true)
    expect(store.state.step).toBe('reset_running')
    expect(store.stepStatus).toBe('running')
  })

  it('ignores choose while a step is running', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().choose('next')
    useSyncRecoveryWizardStore.getState().setStepStatus('running')

    useSyncRecoveryWizardStore.getState().choose('next')

    expect(useSyncRecoveryWizardStore.getState().state.step).toBe('reset_running')
  })

  it('ignores back while a step is running', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().choose('next')
    useSyncRecoveryWizardStore.getState().setStepStatus('running')

    useSyncRecoveryWizardStore.getState().back()

    expect(useSyncRecoveryWizardStore.getState().state.step).toBe('reset_running')
  })

  it('stores the error message when setStepStatus is called with error', () => {
    useSyncRecoveryWizardStore.getState().setStepStatus('error', 'boom')

    const store = useSyncRecoveryWizardStore.getState()
    expect(store.stepStatus).toBe('error')
    expect(store.error).toBe('boom')
  })

  it.each(['idle', 'running', 'done'] as const)(
    'clears the error when setStepStatus is called with %s',
    (status) => {
      useSyncRecoveryWizardStore.getState().setStepStatus('error', 'boom')

      useSyncRecoveryWizardStore.getState().setStepStatus(status)

      const store = useSyncRecoveryWizardStore.getState()
      expect(store.stepStatus).toBe(status)
      expect(store.error).toBeNull()
    },
  )

  it.each([
    ['device_wrong', 'cloud_to_local_confirm'],
    ['cloud_wrong', 'local_to_cloud_confirm'],
    ['stop_syncing', 'stop_choice'],
  ] as const)('advances from triage via %s to %s', (choice, expectedStep) => {
    useSyncRecoveryWizardStore.getState().openWizard()

    useSyncRecoveryWizardStore.getState().choose(choice)

    expect(useSyncRecoveryWizardStore.getState().state.step).toBe(expectedStep)
  })

  it('allows close again after a running step finishes', () => {
    useSyncRecoveryWizardStore.getState().openWizard()
    useSyncRecoveryWizardStore.getState().choose('sync_stuck')
    useSyncRecoveryWizardStore.getState().choose('next')
    useSyncRecoveryWizardStore.getState().setStepStatus('running')
    useSyncRecoveryWizardStore.getState().setStepStatus('done')

    useSyncRecoveryWizardStore.getState().close()

    expect(useSyncRecoveryWizardStore.getState().open).toBe(false)
  })
})
