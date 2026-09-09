import { create } from 'zustand'
import {
  createInitialSecureWizardState,
  nextStep,
  prevStep,
  type SecureWizardChoice,
  type SecureWizardState,
} from '../lib/secureWizardGraph'

export type SecureWizardStepStatus = 'idle' | 'running' | 'done' | 'error'

interface SecureWizardStore {
  open: boolean
  state: SecureWizardState
  stepStatus: SecureWizardStepStatus
  errorKey: string | null
  openWizard: () => void
  openForDevice: (device: { deviceId: string; deviceName: string }) => void
  setTargetDevice: (device: { id: string; name: string }) => void
  close: () => void
  choose: (choice: SecureWizardChoice) => void
  back: () => void
  setStepStatus: (status: SecureWizardStepStatus, errorKey?: string) => void
}

const initialSession = () => ({
  state: createInitialSecureWizardState(),
  stepStatus: 'idle' as SecureWizardStepStatus,
  errorKey: null,
})

export const useSecureWizardStore = create<SecureWizardStore>((set, get) => ({
  open: false,
  ...initialSession(),

  openWizard: () => {
    if (get().stepStatus === 'running') return
    set({ open: true, ...initialSession() })
  },

  openForDevice: ({ deviceId, deviceName }) => {
    if (get().stepStatus === 'running') return
    set({
      open: true,
      ...initialSession(),
      state: {
        ...createInitialSecureWizardState(),
        step: 'device_words',
        targetDevice: { id: deviceId, name: deviceName },
        seeded: true,
      },
    })
  },

  setTargetDevice: (targetDevice) => {
    if (get().stepStatus === 'running') return
    set((current) => ({
      state: { ...current.state, targetDevice },
    }))
  },

  close: () => {
    // In-modal running steps (routine rotation, phrase reset, …) stay locked.
    // Confirm actions close immediately and finish in the background, so
    // rotationBusy / deviceRemovalBusy must not keep the dialog open.
    if (get().stepStatus === 'running') return
    set({ open: false, ...initialSession() })
  },

  choose: (choice) => {
    const current = get()
    if (current.stepStatus === 'running') return
    set({
      state: nextStep(current.state, choice),
      stepStatus: 'idle',
      errorKey: null,
    })
  },

  back: () => {
    const current = get()
    if (current.stepStatus === 'running') return
    set({
      state: prevStep(current.state),
      stepStatus: 'idle',
      errorKey: null,
    })
  },

  setStepStatus: (stepStatus, errorKey) => {
    set({
      stepStatus,
      errorKey: stepStatus === 'error' ? (errorKey ?? null) : null,
    })
  },
}))
