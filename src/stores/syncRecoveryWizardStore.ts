import { create } from 'zustand'
import {
  createInitialSyncRecoveryWizardState,
  nextStep,
  prevStep,
  type SyncRecoveryWizardChoice,
  type SyncRecoveryWizardState,
} from '../lib/syncRecoveryWizardGraph'

export type SyncRecoveryWizardStepStatus = 'idle' | 'running' | 'done' | 'error'

interface SyncRecoveryWizardStore {
  open: boolean
  state: SyncRecoveryWizardState
  stepStatus: SyncRecoveryWizardStepStatus
  /** Already-translated error text for the current step (backend messages carry params). */
  error: string | null
  /** No-op while `stepStatus === 'running'`; resets the session. */
  openWizard: () => void
  /** No-op while running; resets the session. */
  close: () => void
  /** No-op while running; clears `stepStatus` / `error`. */
  choose: (choice: SyncRecoveryWizardChoice) => void
  /** No-op while running; clears `stepStatus` / `error`. */
  back: () => void
  /** `error` is kept only when `status === 'error'`. */
  setStepStatus: (status: SyncRecoveryWizardStepStatus, error?: string) => void
}

const initialSession = () => ({
  state: createInitialSyncRecoveryWizardState(),
  stepStatus: 'idle' as SyncRecoveryWizardStepStatus,
  error: null,
})

export const useSyncRecoveryWizardStore = create<SyncRecoveryWizardStore>((set, get) => ({
  open: false,
  ...initialSession(),

  openWizard: () => {
    if (get().stepStatus === 'running') return
    set({ open: true, ...initialSession() })
  },

  close: () => {
    if (get().stepStatus === 'running') return
    set({ open: false, ...initialSession() })
  },

  choose: (choice) => {
    const current = get()
    if (current.stepStatus === 'running') return
    set({
      state: nextStep(current.state, choice),
      stepStatus: 'idle',
      error: null,
    })
  },

  back: () => {
    const current = get()
    if (current.stepStatus === 'running') return
    set({
      state: prevStep(current.state),
      stepStatus: 'idle',
      error: null,
    })
  },

  setStepStatus: (stepStatus, error) => {
    set({
      stepStatus,
      error: stepStatus === 'error' ? (error ?? null) : null,
    })
  },
}))
