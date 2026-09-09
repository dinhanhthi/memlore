import { useEffect, useRef, useState } from 'react'

import { titlebarRowHeight } from '../lib/windowChrome'
import { useUiStore } from '../stores/uiStore'

/**
 * Direction the logo dog head is looking toward, matching the image filenames
 * in `public/head-rotate/`.
 */
export type LogoDirection = 'default' | 'left' | 'right' | 'down' | 'down-left' | 'down-right'

export const ALL_LOGO_DIRECTIONS: LogoDirection[] = [
  'default',
  'left',
  'right',
  'down',
  'down-left',
  'down-right',
]

const HEAD_ROTATE_PATH = '/head-rotate'

/** Map a direction to its image URL. */
export function logoSrc(direction: LogoDirection): string {
  return `${HEAD_ROTATE_PATH}/${direction}.png`
}

// ── Sector boundaries ──────────────────────────────────────────────────
// Degrees clockwise from east (atan2 convention: 0 = right, 90 = down).
//
//   right:       -30 to  30
//   down-right:   30 to  70
//   down:         70 to 110
//   down-left:   110 to 150
//   left:        150 to 180  ∪  -180 to -150
//   default:    -150 to -30   (above the logo — keep neutral)

/** Nominal centre of each sector, used by hysteresis check. */
const SECTOR_CENTRES: Record<LogoDirection, number> = {
  right: 0,
  'down-right': 50,
  down: 90,
  'down-left': 130,
  left: 165,
  default: -90,
}

/** Hysteresis band (degrees). The cursor must move this far past a boundary
 *  into a new sector before the direction flips, preventing flicker. */
export const HYSTERESIS_DEG = 8

export function angleToDirection(deg: number): LogoDirection {
  // Normalise to -180..180
  if (deg > 180) deg -= 360
  if (deg < -180) deg += 360

  if (deg >= -180 && deg < -150) return 'left'
  if (deg >= -150 && deg < -30) return 'default'
  if (deg >= -30 && deg < 30) return 'right'
  if (deg >= 30 && deg < 70) return 'down-right'
  if (deg >= 70 && deg < 110) return 'down'
  if (deg >= 110 && deg < 150) return 'down-left'
  return 'left'
}

/** Angular distance (shortest arc) between two angles in degrees. */
export function angularDist(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

/**
 * Tracks the mouse position relative to a ref element and returns which
 * head-rotate direction image should be shown.
 *
 * Returns `null` when the feature is disabled (the caller should fall back
 * to the default static logo).
 *
 * Optimisations:
 * - mousemove is coalesced via requestAnimationFrame (one setState per frame)
 * - Hysteresis at sector boundaries prevents flicker
 */
export function useLogoDirection(
  ref: React.RefObject<HTMLElement | null>,
  opts?: { titlebarRow?: boolean },
): LogoDirection | null {
  const enabled = useUiStore((s) => s.logoFollowsCursor)
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const [direction, setDirection] = useState<LogoDirection>('default')

  // Mutable refs so the mousemove handler never triggers re-subscriptions.
  const dirRef = useRef<LogoDirection>('default')
  const rafId = useRef(0)

  useEffect(() => {
    if (!enabled || reducedMotion) return

    const onMouseMove = (e: MouseEvent) => {
      // Coalesce: cancel any pending RAF, schedule a new one.
      cancelAnimationFrame(rafId.current)
      rafId.current = requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return

        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const dx = e.clientX - cx
        const dy = e.clientY - cy

        // Dead-zone near the logo itself
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) {
          if (dirRef.current !== 'default') {
            dirRef.current = 'default'
            setDirection('default')
          }
          return
        }

        // When cursor is on the title bar row, always look right (titlebar logo only)
        if (
          opts?.titlebarRow &&
          e.clientY <= titlebarRowHeight(useUiStore.getState().designSystem)
        ) {
          if (dirRef.current !== 'right') {
            dirRef.current = 'right'
            setDirection('right')
          }
          return
        }

        const deg = Math.atan2(dy, dx) * (180 / Math.PI)
        const candidate = angleToDirection(deg)

        // Hysteresis: stick with current direction unless the cursor has
        // moved well past the boundary into the new sector's territory.
        if (candidate !== dirRef.current) {
          const distToCurrent = angularDist(deg, SECTOR_CENTRES[dirRef.current])
          const distToCandidate = angularDist(deg, SECTOR_CENTRES[candidate])
          if (distToCurrent - distToCandidate < HYSTERESIS_DEG) return
          dirRef.current = candidate
          setDirection(candidate)
        }
      })
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      cancelAnimationFrame(rafId.current)
      dirRef.current = 'default'
    }
  }, [enabled, reducedMotion, ref])

  if (!enabled || reducedMotion) return null
  return direction
}
