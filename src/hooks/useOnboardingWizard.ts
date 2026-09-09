import { useCallback, useEffect, useReducer, useRef } from 'react'
import { type GdriveConnectStatus, useGdriveConnectStore } from '../stores/gdriveConnectStore'
import { useOnboardingStore, type WizardCelebrationVariant } from '../stores/onboardingStore'

// ─── State machine ────────────────────────────────────────────────────────────

export type OnboardingStep =
  | { kind: 'journal' }
  | { kind: 'theme' }
  | { kind: 'drive' }
  | { kind: 'ai' }
  | { kind: 'done' }

// Linear order the wizard walks through. Interface language is chosen earlier,
// before the vault is created (on the welcome/choose-mode screen), so it is
// NOT a wizard step. `theme` always has a default; `journal` is mandatory (no
// skip in its UI); `drive`/`ai` are skippable. None of that is enforced here —
// the reducer only sequences steps, the component decides which steps show a
// Skip button.
const STEP_ORDER: OnboardingStep['kind'][] = ['theme', 'journal', 'drive', 'ai', 'done']

type Action = { type: 'ADVANCE' } | { type: 'BACK' }

function reducer(state: OnboardingStep, action: Action): OnboardingStep {
  const index = STEP_ORDER.indexOf(state.kind)
  switch (action.type) {
    case 'ADVANCE': {
      // Already at the last step — no-op (keeps the same reference so a
      // stray extra next()/skip() call after `done` doesn't re-trigger the
      // done-transition effect below).
      if (index === STEP_ORDER.length - 1) return state
      return { kind: STEP_ORDER[index + 1] }
    }
    case 'BACK': {
      // First step — no-op. Also covers `done`: decrementing from the last
      // index never lands back on `done` itself, only on `ai`.
      if (index <= 0) return state
      return { kind: STEP_ORDER[index - 1] }
    }
    default:
      return state
  }
}

/**
 * Pure: which celebration copy to arm when the post-setup wizard finishes.
 *
 * A cloud provider counts as linked when the wizard shell already observed a
 * connection *or* the connect store reports `success` — the latter covers
 * advancing past Drive right after connect resolved (DriveStep unmounts, so
 * `driveConnected` alone can lag).
 *
 * `connecting` deliberately does NOT count. An in-flight connect can still
 * fail, and `setup-sync` asserts the sync IS running — while its modal is up
 * `shouldSurfaceConnectResult` suppresses the connect toast, so the user
 * would be reassured and then handed a "connection failed" toast the moment
 * they dismiss it. A slow-but-successful connect showing the generic welcome
 * is the cheaper miss.
 */
export function celebrationVariantForWizardDone(input: {
  driveConnected: boolean
  connectStatus: GdriveConnectStatus
}): WizardCelebrationVariant {
  const linked = input.driveConnected || input.connectStatus === 'success'
  return linked ? 'setup-sync' : 'setup'
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseOnboardingWizard {
  step: OnboardingStep
  /** Advance to the next step in the linear order. No-op from `done`. */
  next: () => void
  /** Same effect as `next()` — semantically "skip this optional step". */
  skip: () => void
  /** Go to the previous step. No-op from the first step (`theme`). */
  back: () => void
}

export interface UseOnboardingWizardOptions {
  /**
   * Whether a cloud provider was connected during this wizard run. When true
   * at `done`, the celebration modal uses the "first sync is running" copy so
   * the user knows to watch the footer instead of a silent background sync.
   */
  driveConnected?: boolean
}

export function useOnboardingWizard(
  initialStep: OnboardingStep['kind'] = 'theme',
  options: UseOnboardingWizardOptions = {},
): UseOnboardingWizard {
  const { driveConnected = false } = options
  const [step, dispatch] = useReducer(reducer, { kind: initialStep })
  // Latest flag for the done-transition effect without re-running it when
  // Drive connects after the wizard has already exited (would re-arm the
  // one-shot modal).
  const driveConnectedRef = useRef(driveConnected)
  driveConnectedRef.current = driveConnected

  // The reducer stays pure — it never calls the store. Clearing the pending
  // flag is a side effect of *reaching* `done`, so it belongs here, mirroring
  // how useFirstTimeSetup keeps its terminal-state side effects (e.g. the
  // CONFIRM_SUCCESS -> `done` transition there) out of the reducer itself.
  useEffect(() => {
    if (step.kind === 'done') {
      const connectStatus = useGdriveConnectStore.getState().status
      useOnboardingStore.getState().clearPending(
        celebrationVariantForWizardDone({
          driveConnected: driveConnectedRef.current,
          connectStatus,
        }),
      )
    }
  }, [step.kind])

  const next = useCallback(() => dispatch({ type: 'ADVANCE' }), [])
  const skip = useCallback(() => dispatch({ type: 'ADVANCE' }), [])
  const back = useCallback(() => dispatch({ type: 'BACK' }), [])

  return { step, next, skip, back }
}
