import type { SyncRecoveryStatus } from './tauri'

/**
 * Drive an interrupted recovery job to completion by calling `resumeRecovery`
 * once per step until it is no longer active/resumable.
 *
 * Each resume advances exactly one bounded `SyncRecoveryStep` (see
 * `SyncRecoveryStep` in `src-tauri/src/commands/gdrive.rs`), so termination
 * is progress-based rather than an arbitrary iteration cap: if a resume call
 * returns the same `(phase, status)` pair as before that call, the job made
 * no progress and we error out rather than looping forever.
 *
 * The unit of progress is a *step*, not a phase rank — one step may cross
 * several ranks (`LocalFinalize` runs transfer→verify→commit→finalize→
 * fence_release_pending). That is fine here: the check only requires the
 * `(phase, status)` pair to differ. It would need revisiting if a step ever
 * checkpoints durable progress while staying on the same pair (e.g. a
 * chunked transfer) — then key the comparison on `updatedAt` or a step
 * counter instead.
 */
export async function resumeRecoveryUntilSettled(
  initial: SyncRecoveryStatus | null,
  resumeRecovery: () => Promise<SyncRecoveryStatus>,
): Promise<SyncRecoveryStatus | null> {
  let next = initial
  while (next?.isActive && next.canResume) {
    const before = `${next.phase}:${next.status}`
    next = await resumeRecovery()
    const after = `${next.phase}:${next.status}`
    if (after === before) {
      throw new Error(
        `recovery resume made no progress at phase "${next.phase}" (status "${next.status}")`,
      )
    }
  }
  return next
}
