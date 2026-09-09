import { beforeEach, describe, expect, it } from 'vitest'
import { useSecureWizardStore } from './secureWizardStore'
import { useUiStore } from './uiStore'

beforeEach(() => {
  useUiStore.getState().setRotationBusy(false)
  useUiStore.getState().setDeviceRemovalBusy(false)
  useSecureWizardStore.getState().setStepStatus('idle')
  useSecureWizardStore.getState().close()
})

describe('secureWizardStore', () => {
  it('opens a pre-seeded device flow at the device words step', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })

    const store = useSecureWizardStore.getState()
    expect(store.open).toBe(true)
    expect(store.state.step).toBe('device_words')
    expect(store.state.targetDevice).toEqual({
      id: 'device-2',
      name: 'Lost laptop',
    })
    expect(store.state.seeded).toBe(true)
  })

  it('stores a selected target device in the ordinary device-picker flow', () => {
    useSecureWizardStore.getState().openWizard()
    useSecureWizardStore.getState().choose('device_compromised')

    useSecureWizardStore.getState().setTargetDevice({
      id: 'device-3',
      name: 'Office Mac',
    })
    useSecureWizardStore.getState().choose('next')

    const store = useSecureWizardStore.getState()
    expect(store.state.step).toBe('device_words')
    expect(store.state.targetDevice).toEqual({
      id: 'device-3',
      name: 'Office Mac',
    })
    expect(store.state.seeded).toBe(false)
  })

  it('fully resets state when closed so a target device cannot leak into a new session', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useSecureWizardStore.getState().setStepStatus('error', 'settings:security.error')

    useSecureWizardStore.getState().close()
    useSecureWizardStore.getState().openWizard()

    const store = useSecureWizardStore.getState()
    expect(store.open).toBe(true)
    expect(store.state.step).toBe('triage')
    expect(store.state.targetDevice).toBeNull()
    expect(store.state.seeded).toBe(false)
    expect(store.stepStatus).toBe('idle')
    expect(store.errorKey).toBeNull()
  })

  it('does not navigate back while a step is running', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useSecureWizardStore.getState().setStepStatus('running')

    useSecureWizardStore.getState().back()

    expect(useSecureWizardStore.getState().state.step).toBe('device_words')
  })

  it('delegates forward and backward navigation to the wizard graph', () => {
    useSecureWizardStore.getState().openWizard()

    useSecureWizardStore.getState().choose('words_leaked')
    expect(useSecureWizardStore.getState().state.step).toBe('words_leaked')

    useSecureWizardStore.getState().back()
    expect(useSecureWizardStore.getState().state.step).toBe('triage')
  })

  it('does not apply choices while a step is running', () => {
    useSecureWizardStore.getState().openWizard()
    useSecureWizardStore.getState().setStepStatus('running')

    useSecureWizardStore.getState().choose('words_leaked')

    expect(useSecureWizardStore.getState().state.step).toBe('triage')
  })

  it('does not close or reset the session while a step is running', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useSecureWizardStore.getState().setStepStatus('running')

    useSecureWizardStore.getState().close()

    const store = useSecureWizardStore.getState()
    expect(store.open).toBe(true)
    expect(store.state.step).toBe('device_words')
    expect(store.state.targetDevice?.id).toBe('device-2')
    expect(store.stepStatus).toBe('running')
  })

  it('does not replace a running session with a fresh wizard', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useSecureWizardStore.getState().setStepStatus('running')

    useSecureWizardStore.getState().openWizard()

    const store = useSecureWizardStore.getState()
    expect(store.state.step).toBe('device_words')
    expect(store.state.targetDevice?.id).toBe('device-2')
    expect(store.stepStatus).toBe('running')
  })

  it('does not replace a running session with another seeded device', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useSecureWizardStore.getState().setStepStatus('running')

    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-4',
      deviceName: 'Other laptop',
    })

    const store = useSecureWizardStore.getState()
    expect(store.state.targetDevice).toEqual({
      id: 'device-2',
      name: 'Lost laptop',
    })
    expect(store.stepStatus).toBe('running')
  })

  it('closes after confirm even if a background rotation or removal is already busy', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useUiStore.getState().setRotationBusy(true)
    useUiStore.getState().setDeviceRemovalBusy(true)

    useSecureWizardStore.getState().close()

    const store = useSecureWizardStore.getState()
    expect(store.open).toBe(false)
    expect(store.state.step).toBe('triage')
    expect(store.state.targetDevice).toBeNull()
    expect(useUiStore.getState().rotationBusy).toBe(true)
    expect(useUiStore.getState().deviceRemovalBusy).toBe(true)
  })

  it('closes the wizard when no rotation is running and stepStatus is idle', () => {
    useSecureWizardStore.getState().openForDevice({
      deviceId: 'device-2',
      deviceName: 'Lost laptop',
    })
    useUiStore.getState().setRotationBusy(false)

    useSecureWizardStore.getState().close()

    const store = useSecureWizardStore.getState()
    expect(store.open).toBe(false)
    expect(store.state.step).toBe('triage')
    expect(store.state.targetDevice).toBeNull()
    expect(store.stepStatus).toBe('idle')
  })
})
