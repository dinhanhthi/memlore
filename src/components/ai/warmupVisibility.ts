/**
 * Pure visibility selector for the on-device LLM warm-up modal
 * (Phase 5 Task 3).
 *
 * Extracted out of `ModelWarmupModal.tsx` deliberately: the modal is a
 * `.tsx` (JSX) so a co-located Vitest case would have to be a
 * `.test.tsx` — and the project rule forbids component tests. Keeping
 * the state-transition logic in this `.ts` module lets the selector be
 * unit-tested directly while the component imports it for the same
 * single source of truth.
 *
 * Contract (the order of rules matters — earlier rules win):
 *  1. Wrong generation provider        → `hidden`  (not our slot).
 *  2. User dismissed this cycle        → `hidden`  (until the next
 *                                         `starting` cycle resets it;
 *                                         the reset is component state,
 *                                         see `ModelWarmupModal`).
 *  3. Server `failed`                  → `failed`  (error variant).
 *  4. Server `starting` for >= 300ms   → `visible` (flicker guard).
 *  5. Server `starting` for < 300ms    → `hidden`  (not yet — avoid flicker).
 *  6. Server `ready` / `stopped`       → `hidden`  (auto-dismiss).
 *
 * `now` is injected (not read from `Date.now()` inside the fn) so the
 * 300ms flicker guard is deterministic under test.
 */
import type { LlmServerState } from '../../hooks/useOnDeviceLlmModels'

/** Warm-up modal visibility. The component renders one of three views. */
export type WarmupVisibility = 'hidden' | 'visible' | 'failed'

/** Flicker guard — only surface the modal if `starting` has lasted at
 *  least this long. Sub-300ms starts (warm cache) never bother the user. */
export const WARMUP_FLICKER_GUARD_MS = 300

export interface WarmupVisibilityOpts {
  /** The active generation provider id (`providers.generation?.provider`).
   *  `null` when no generation slot is configured. */
  generationProvider: string | null
  /** Current llama-server lifecycle state. */
  serverState: LlmServerState
  /** Timestamp (ms) when the server entered `starting`, or `null` when
   *  it is not currently starting. The component tracks this by watching
   *  `serverStatus.state` transitions. */
  startingSince: number | null
  /** Current time (ms) — injected for testability. */
  now: number
  /** True once the user clicked "Continue in background" this cycle.
   *  Resets to `false` when a NEW `starting` cycle begins (component
   *  effects clear it when `startingSince` changes to a new value). */
  userDismissed: boolean
}

export function warmupVisibility(opts: WarmupVisibilityOpts): WarmupVisibility {
  const { generationProvider, serverState, startingSince, now, userDismissed } = opts

  // (1) Not our provider — stay out of the way entirely.
  if (generationProvider !== 'on-device-llm') return 'hidden'
  // (2) User dismissed this starting cycle — keep it hidden until the
  //     next cycle resets `userDismissed` (component-side effect).
  if (userDismissed) return 'hidden'
  // (3) Failure always wins over the flicker guard so the user sees why
  //     their reply never came.
  if (serverState === 'failed') return 'failed'
  // (4)/(5) Flicker guard: only show after `starting` has persisted.
  if (serverState === 'starting') {
    if (startingSince !== null && now - startingSince >= WARMUP_FLICKER_GUARD_MS) {
      return 'visible'
    }
    return 'hidden'
  }
  // (6) `ready` (auto-dismiss — the reply is now instant) or `stopped`.
  return 'hidden'
}
