import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { create } from 'zustand'

// ─── Wire payload (Rust → TS) ─────────────────────────────────────────────────

/** Shape of the `xj://rotation-resume-required` event payload from Rust. */
interface RotationResumePayload {
  state: string
  /** `true` when the interrupted job is a REVOKE (requires 24-word phrase). */
  is_revoke: boolean
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface RotationResumeStore {
  /** True when a `xj://rotation-resume-required` event has been received. */
  resumeRequired: boolean
  /** The rotation job state at the time of detection (e.g. "reencrypt"). */
  jobState: string | null
  /**
   * True when the interrupted job is a device-revocation rotation (REVOKE).
   * False for plain key rotations (ROTATE). Only valid when `resumeRequired`.
   */
  isRevoke: boolean
  setResumeRequired: (payload: RotationResumePayload) => void
  clearResumeRequired: () => void
}

export const useRotationResumeStore = create<RotationResumeStore>((set) => ({
  resumeRequired: false,
  jobState: null,
  isRevoke: false,
  setResumeRequired: (payload) =>
    set({ resumeRequired: true, jobState: payload.state, isRevoke: payload.is_revoke }),
  clearResumeRequired: () => set({ resumeRequired: false, jobState: null, isRevoke: false }),
}))

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseRotationResumeReturn {
  resumeRequired: boolean
  jobState: string | null
  /** True when the interrupted job is a REVOKE (requires phrase). */
  isRevoke: boolean
  clearResumeRequired: () => void
}

/**
 * Subscribes to the `xj://rotation-resume-required` Tauri event, emitted by
 * `initialize_encryption` when it detects an interrupted rotation job on
 * startup (crash-recovery).
 *
 * State is backed by a Zustand store so any component can also trigger the
 * modal imperatively via `useRotationResumeStore.getState().setResumeRequired(payload)`.
 */
export function useRotationResume(): UseRotationResumeReturn {
  const resumeRequired = useRotationResumeStore((s) => s.resumeRequired)
  const jobState = useRotationResumeStore((s) => s.jobState)
  const isRevoke = useRotationResumeStore((s) => s.isRevoke)
  const { setResumeRequired, clearResumeRequired } = useRotationResumeStore.getState()

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    let cancelled = false

    async function subscribe() {
      const unlisten = await listen<RotationResumePayload>(
        'xj://rotation-resume-required',
        (event) => {
          // Map wire field `is_revoke` (Rust snake_case) to the store's `isRevoke`.
          setResumeRequired(event.payload)
        },
      )
      if (cancelled) {
        unlisten()
        return
      }
      unlisteners.push(unlisten)
    }

    void subscribe()

    return () => {
      cancelled = true
      for (const u of unlisteners) u()
    }
  }, [setResumeRequired])

  return {
    resumeRequired,
    jobState,
    isRevoke,
    clearResumeRequired,
  }
}
