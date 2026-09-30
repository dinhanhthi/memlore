import { useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

const DEFAULT_DURATION_MS = 900

function finiteGoal(target: number): number {
  if (!Number.isFinite(target)) return 0
  return Math.round(target)
}

/** Ease-out cubic: fast start, soft landing. `t` is 0–1. */
function outCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

/**
 * One-shot count-up for story numerals.
 *
 * Eases from 0 to `target` on the first mount only. A later `target` (a
 * refetch) jumps straight to the new value so the number does not replay.
 * Reduced motion paints `target` on the first render. Reads
 * `usePrefersReducedMotion` and never `useReducedMotion`, which owns the
 * document `reduce-motion` class.
 */
export function useCountUp(target: number, options?: { durationMs?: number }): number {
  const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS
  const reduced = usePrefersReducedMotion()
  const goal = finiteGoal(target)
  // null means "show goal": reduced motion, a zero target, or a finished count.
  const [animated, setAnimated] = useState<number | null>(reduced || goal === 0 ? null : 0)
  // Stays false until a frame runs, so StrictMode's sync effect restart still
  // plays the animation. After that, target changes jump.
  const settled = useRef(false)
  const trackedGoal = useRef(goal)

  if (settled.current && trackedGoal.current !== goal) {
    trackedGoal.current = goal
    if (animated !== null) setAnimated(null)
  }

  useEffect(() => {
    if (reduced || goal === 0 || settled.current) {
      settled.current = true
      trackedGoal.current = goal
      return
    }

    trackedGoal.current = goal
    let frame = 0
    const start = performance.now()

    const step = (timestamp: number) => {
      settled.current = true
      const elapsed = Math.max(0, timestamp - start)
      const t = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs)
      if (t >= 1) {
        setAnimated(null)
        return
      }
      setAnimated(Math.round(goal * outCubic(t)))
      frame = requestAnimationFrame(step)
    }

    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [goal, durationMs, reduced])

  return animated === null ? goal : animated
}
