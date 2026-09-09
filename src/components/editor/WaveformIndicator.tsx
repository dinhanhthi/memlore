import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getRecordingLevels } from '../../lib/tauri'

interface WaveformIndicatorProps {
  /** When `true`, polls the backend on every animation frame and updates the
   *  bars. When `false`, the component stops polling and renders a flat row
   *  of zero-height bars. */
  active: boolean
  /** Number of vertical bars to render. Defaults to 32 — wide enough to look
   *  like a real spectrum analyzer without being noisy. */
  bars?: number
}

/** Minimum bar height (% of container) so empty silence still shows a flat
 *  baseline rather than vanishing into nothing. */
const MIN_BAR_PCT = 6
/** Bars below this RMS map to the baseline; above it, they scale linearly. */
const NOISE_FLOOR = 0.01
/** Empirical gain — typical close-mic speech RMS is well under 0.1, so we
 *  multiply by 6× before clamping so normal voice fills most of the meter. */
const GAIN = 6
/** Polling cadence in ms. ~30 fps is plenty for a VU-meter animation and
 *  cheaper than 60 fps (especially for the IPC round-trip). */
const POLL_INTERVAL_MS = 33

/**
 * Live RMS waveform indicator backed by the cpal sample buffer in Rust. While
 * `active`, polls `get_recording_levels(bucketCount)` ~30× per second and
 * animates each bar's height with a short CSS transition for smoothness.
 *
 * The component intentionally renders nothing visual when `active` is false
 * (returns a row of flat bars at `MIN_BAR_PCT`) so the modal layout stays
 * stable across recording / idle states.
 */
export function WaveformIndicator({ active, bars = 32 }: WaveformIndicatorProps) {
  const { t } = useTranslation('editor')
  const [levels, setLevels] = useState<number[]>(() => new Array(bars).fill(0))
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!active) {
      setLevels(new Array(bars).fill(0))
      return
    }

    let cancelled = false

    const tick = async () => {
      try {
        const raw = await getRecordingLevels(bars)
        if (cancelled) return
        if (raw.length === 0) {
          setLevels(new Array(bars).fill(0))
        } else {
          setLevels(raw)
        }
      } catch {
        // Backend may not have started capturing yet on the first frame —
        // swallow and retry on the next tick.
      }
    }

    void tick()
    intervalRef.current = setInterval(() => {
      void tick()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [active, bars])

  return (
    <div
      role="img"
      aria-label={t('voice_memo.level_aria')}
      className="flex h-12 w-full items-center justify-center gap-1"
    >
      {levels.map((rms, i) => {
        const boosted = Math.max(0, rms - NOISE_FLOOR) * GAIN
        const pct = Math.min(100, MIN_BAR_PCT + boosted * 100)
        return (
          <span
            key={i}
            aria-hidden="true"
            className="bg-danger w-[3px] rounded-full motion-safe:transition-[height] motion-safe:duration-75"
            style={{ height: `${pct}%` }}
          />
        )
      })}
    </div>
  )
}
