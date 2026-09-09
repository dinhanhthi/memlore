import { useCallback, useEffect, useReducer } from 'react'
import * as tauri from '../lib/tauri'

// ─── State machine ────────────────────────────────────────────────────────────

// `password_entered` is defined in the spec but the state machine transitions
// directly to `mnemonic_revealed` (idle → submitting → mnemonic_revealed).
// It is kept in the union for forward-compat; the hook never transitions to it.

export type SetupStage =
  | { kind: 'idle' }
  | { kind: 'password_entered'; password: string; deviceName: string }
  | {
      kind: 'mnemonic_revealed'
      setupId: string
      mnemonic: string[]
      challengeIndices: number[]
      isResumed?: boolean
    }
  | {
      kind: 'confirm_pending'
      setupId: string
      mnemonic: string[]
      challengeIndices: number[]
      /** Inline error — stays in confirm_pending so the user can retry. */
      error?: string
    }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

type Action =
  | { type: 'BEGIN_SUBMITTING' }
  | {
      type: 'BEGIN_SUCCESS'
      setupId: string
      mnemonic: string[]
      challengeIndices: number[]
      isResumed?: boolean
    }
  | { type: 'BEGIN_FAILURE'; message: string }
  | { type: 'PROCEED_TO_CONFIRM' }
  | {
      type: 'CONFIRM_FAILURE'
      /** Restore data so the user can retry without losing the wizard position. */
      setupId: string
      mnemonic: string[]
      challengeIndices: number[]
      message: string
    }
  | { type: 'CONFIRM_SUCCESS' }
  | { type: 'CANCEL' }

function reducer(state: SetupStage, action: Action): SetupStage {
  switch (action.type) {
    case 'BEGIN_SUBMITTING':
      return { kind: 'submitting' }

    case 'BEGIN_SUCCESS':
      return {
        kind: 'mnemonic_revealed',
        setupId: action.setupId,
        mnemonic: action.mnemonic,
        challengeIndices: action.challengeIndices,
        isResumed: action.isResumed,
      }

    case 'BEGIN_FAILURE':
      return { kind: 'error', message: action.message }

    case 'PROCEED_TO_CONFIRM': {
      if (state.kind !== 'mnemonic_revealed') return state
      return {
        kind: 'confirm_pending',
        setupId: state.setupId,
        mnemonic: state.mnemonic,
        challengeIndices: state.challengeIndices,
      }
    }

    case 'CONFIRM_FAILURE':
      // Restore confirm_pending with inline error so the user can retry
      return {
        kind: 'confirm_pending',
        setupId: action.setupId,
        mnemonic: action.mnemonic,
        challengeIndices: action.challengeIndices,
        error: action.message,
      }

    case 'CONFIRM_SUCCESS':
      return { kind: 'done' }

    case 'CANCEL':
      return { kind: 'idle' }

    default:
      return state
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseFirstTimeSetup {
  stage: SetupStage
  beginSetup: (password: string, deviceName: string) => Promise<void>
  proceedToConfirm: () => void
  cancelSetup: () => Promise<void>
  /**
   * `unlockMethod` is how this device will unlock day to day (picked in the
   * wizard's step 0). Omitted means password-only — the backend default and
   * the safe fallback for a resumed setup that never saw the picker.
   */
  submitConfirmation: (
    answers: string[],
    password: string,
    unlockMethod?: tauri.UnlockMethod,
  ) => Promise<void>
  /** Exposed for tests; the hook also calls it automatically on mount. */
  resume: () => Promise<void>
}

export function useFirstTimeSetup(sessionId?: string): UseFirstTimeSetup {
  const [stage, dispatch] = useReducer(reducer, { kind: 'idle' })

  // Crash-recovery probe on mount. Uses a cancelled flag for React 18
  // StrictMode double-mount safety (same pattern as useAuth.ts).
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const pending = await tauri.getPendingFirstTimeSetup()
        if (cancelled) return
        if (pending) {
          dispatch({
            type: 'BEGIN_SUCCESS',
            setupId: pending.setup_id,
            mnemonic: pending.mnemonic,
            challengeIndices: pending.challenge_indices,
            isResumed: true,
          })
        }
      } catch {
        // Non-fatal; user starts fresh
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const resume = useCallback(async (): Promise<void> => {
    try {
      const pending = await tauri.getPendingFirstTimeSetup()
      if (pending) {
        dispatch({
          type: 'BEGIN_SUCCESS',
          setupId: pending.setup_id,
          mnemonic: pending.mnemonic,
          challengeIndices: pending.challenge_indices,
          isResumed: true,
        })
      }
    } catch (err) {
      console.warn('Failed to probe pending first-time setup:', err)
    }
  }, [])

  const beginSetup = useCallback(async (password: string, deviceName: string): Promise<void> => {
    dispatch({ type: 'BEGIN_SUBMITTING' })
    try {
      const handle = await tauri.beginFirstTimeSetup(password, deviceName)
      dispatch({
        type: 'BEGIN_SUCCESS',
        setupId: handle.setup_id,
        mnemonic: handle.mnemonic,
        challengeIndices: handle.challenge_indices,
      })
    } catch (err) {
      // Tauri rejects with plain strings (typed-error sentinels live in those
      // strings — e.g. UNSAFE_SETUP_DRIVE_CONNECTED_BUT_UNCLAIMED and
      // CLOUD_VAULT_EXISTS_USE_ONBOARDING from the backend Phase 2 guards).
      // Preserve the raw string so the caller can pattern-match the sentinel.
      const message =
        typeof err === 'string' ? err : err instanceof Error ? err.message : 'Failed to begin setup'
      dispatch({ type: 'BEGIN_FAILURE', message })
    }
  }, [])

  const proceedToConfirm = useCallback(() => {
    dispatch({ type: 'PROCEED_TO_CONFIRM' })
  }, [])

  const cancelSetup = useCallback(async (): Promise<void> => {
    // Extract setupId from whichever state has it before resetting
    let setupId: string | null = null
    if (stage.kind === 'mnemonic_revealed' || stage.kind === 'confirm_pending') {
      setupId = stage.setupId
    }
    dispatch({ type: 'CANCEL' })
    if (setupId) {
      try {
        await tauri.cancelFirstTimeSetup(setupId)
      } catch (err) {
        console.warn('cancelFirstTimeSetup failed:', err)
      }
    }
  }, [stage])

  const submitConfirmation = useCallback(
    async (
      answers: string[],
      password: string,
      unlockMethod?: tauri.UnlockMethod,
    ): Promise<void> => {
      if (stage.kind !== 'confirm_pending') return
      const { setupId, mnemonic, challengeIndices } = stage
      try {
        await tauri.confirmFirstTimeSetup(setupId, answers, password, sessionId, unlockMethod)
        dispatch({ type: 'CONFIRM_SUCCESS' })
      } catch (err) {
        // Tauri rejects with plain strings, not Error objects — handle both.
        const message =
          typeof err === 'string' ? err : err instanceof Error ? err.message : 'Confirmation failed'
        // Return to confirm_pending (same data) with inline error for retry.
        dispatch({ type: 'CONFIRM_FAILURE', setupId, mnemonic, challengeIndices, message })
        // Re-throw so the screen's catch can run (e.g. clear the password field).
        throw new Error(message)
      }
    },
    [stage, sessionId],
  )

  return {
    stage,
    beginSetup,
    proceedToConfirm,
    cancelSetup,
    submitConfirmation,
    resume,
  }
}
