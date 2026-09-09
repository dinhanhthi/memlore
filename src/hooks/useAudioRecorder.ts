import { useCallback, useEffect, useRef, useState } from 'react'
import {
  discardAudioMemo,
  readAudioMemoBytes,
  saveAudioMemo,
  startRecording,
  stopRecording,
} from '../lib/tauri'
import type { PickMediaResult } from '../lib/tauri'

export type RecordingState = 'idle' | 'recording' | 'preview' | 'saving' | 'error'

export interface UseAudioRecorderResult {
  state: RecordingState
  sessionId: string | null
  /** Elapsed recording time in whole seconds while `recording`. Frozen at the
   *  final duration once `stop` resolves and the preview opens. */
  elapsed: number
  error: string | null
  /** Blob URL to play the recorded WAV while in `preview` state. */
  previewUrl: string | null
  /** Begin recording. Transitions idle → recording. */
  start: () => void
  /**
   * Stop recording and enter `preview` state — the temp WAV is read and a
   * Blob URL is exposed via `previewUrl` so the modal can play it back.
   * Calling `stop` while not in `recording` state is a safe no-op.
   */
  stop: () => void
  /**
   * Persist the previewed memo. Transitions preview → saving → idle.
   * `onDone` receives the persisted `PickMediaResult` on success.
   * Must be called while `state === 'preview'`.
   */
  save: (entryId: string, onDone: (result: PickMediaResult) => void) => void
  /**
   * Discard the previewed memo: delete the temp WAV and reset to `idle`.
   * Safe to call from preview or error states.
   */
  discard: () => void
  /** Return to `idle` from any state (clears error, resets elapsed). */
  reset: () => void
}

/**
 * Manages the full audio recording lifecycle:
 *
 * ```
 * idle → recording → preview → saving → idle
 *                          ↘ idle (discard)
 *                  ↘ error ↗
 * ```
 *
 * The `preview` state lets the user listen to the take and choose Save or
 * Cancel before the WAV is moved into the media directory.
 */
export function useAudioRecorder(): UseAudioRecorderResult {
  const [state, setState] = useState<RecordingState>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const tempPathRef = useRef<string | null>(null)
  const durationRef = useRef<number>(0)
  const previewUrlRef = useRef<string | null>(null)

  const clearTicker = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const revokePreview = useCallback(() => {
    if (previewUrlRef.current !== null) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
      setPreviewUrl(null)
    }
  }, [])

  // On unmount: stop a live recording, discard a pending preview, revoke any
  // blob URL — best-effort cleanup so the backend doesn't keep capturing or
  // leak temp WAV files if the component disappears mid-flow.
  useEffect(() => {
    return () => {
      clearTicker()
      revokePreview()
      const sid = sessionIdRef.current
      if (sid !== null) {
        void Promise.resolve(stopRecording(sid)).catch(() => {
          // unmounted — nothing to do
        })
      }
      const tempPath = tempPathRef.current
      if (tempPath !== null) {
        void Promise.resolve(discardAudioMemo(tempPath)).catch(() => {
          // unmounted — nothing to do
        })
      }
    }
  }, [clearTicker, revokePreview])

  const start = useCallback(() => {
    setElapsed(0)
    setError(null)

    startRecording()
      .then((id) => {
        sessionIdRef.current = id
        setSessionId(id)
        setState('recording')
        intervalRef.current = setInterval(() => {
          setElapsed((prev) => prev + 1)
        }, 1000)
      })
      .catch((err: unknown) => {
        clearTicker()
        setState('error')
        setError(err instanceof Error ? err.message : String(err))
        sessionIdRef.current = null
        setSessionId(null)
      })
  }, [clearTicker])

  const stop = useCallback(() => {
    if (state !== 'recording' || sessionId === null) return

    clearTicker()
    const sid = sessionId
    sessionIdRef.current = null

    stopRecording(sid)
      .then(async ({ tempPath, durationSeconds }) => {
        tempPathRef.current = tempPath
        durationRef.current = durationSeconds
        const bytes = await readAudioMemoBytes(tempPath)
        // Tauri returns Vec<u8> as number[] over IPC; convert to Uint8Array
        // for Blob construction.
        const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)
        previewUrlRef.current = url
        setPreviewUrl(url)
        setElapsed(Math.round(durationSeconds))
        setSessionId(null)
        setState('preview')
      })
      .catch((err: unknown) => {
        setState('error')
        setError(err instanceof Error ? err.message : String(err))
        setSessionId(null)
      })
  }, [state, sessionId, clearTicker])

  const save = useCallback(
    (entryId: string, onDone: (result: PickMediaResult) => void) => {
      const tempPath = tempPathRef.current
      if (state !== 'preview' || tempPath === null) return

      setState('saving')
      saveAudioMemo(entryId, tempPath, durationRef.current)
        .then((result) => {
          tempPathRef.current = null
          revokePreview()
          onDone(result)
          setElapsed(0)
          setState('idle')
        })
        .catch((err: unknown) => {
          setState('error')
          setError(err instanceof Error ? err.message : String(err))
        })
    },
    [state, revokePreview],
  )

  const discard = useCallback(() => {
    const tempPath = tempPathRef.current
    revokePreview()
    if (tempPath !== null) {
      tempPathRef.current = null
      void discardAudioMemo(tempPath).catch(() => {
        // best-effort — temp file may already be gone
      })
    }
    setElapsed(0)
    setError(null)
    setState('idle')
  }, [revokePreview])

  const reset = useCallback(() => {
    clearTicker()
    sessionIdRef.current = null
    const tempPath = tempPathRef.current
    if (tempPath !== null) {
      tempPathRef.current = null
      void discardAudioMemo(tempPath).catch(() => {
        // best-effort
      })
    }
    revokePreview()
    setState('idle')
    setSessionId(null)
    setElapsed(0)
    setError(null)
  }, [clearTicker, revokePreview])

  return { state, sessionId, elapsed, error, previewUrl, start, stop, save, discard, reset }
}
