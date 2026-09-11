import { useEffect, useRef, useState } from 'react'
import {
  ALL_LOGO_DIRECTIONS,
  angularDist,
  DEAD_ZONE_RATIO,
  HYSTERESIS_DEG,
  isAngledDirection,
  logoSrc,
  pointerToDirection,
  SECTOR_CENTRES,
  type LogoDirection,
} from './logoDirection'

type HeadFollowLogoProps = {
  alt: string
  className?: string
  size: number
}

export function preloadHeadSprites() {
  for (const direction of ALL_LOGO_DIRECTIONS) {
    const image = new Image()
    image.src = logoSrc(direction)
  }
}

function useHeadDirection(ref: React.RefObject<HTMLElement | null>): LogoDirection {
  const [direction, setDirection] = useState<LogoDirection>('default')
  const dirRef = useRef<LogoDirection>('default')
  const rafId = useRef(0)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reduced.matches) return

    const onMouseMove = (event: MouseEvent) => {
      cancelAnimationFrame(rafId.current)
      rafId.current = requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const dx = event.clientX - (rect.left + rect.width / 2)
        const dy = event.clientY - (rect.top + rect.height / 2)
        const radius = Math.min(rect.width, rect.height) * DEAD_ZONE_RATIO
        const candidate = pointerToDirection(dx, dy, radius)
        if (candidate === dirRef.current) return
        if (
          candidate === 'straight' ||
          dirRef.current === 'straight' ||
          dirRef.current === 'default' ||
          !isAngledDirection(dirRef.current) ||
          !isAngledDirection(candidate)
        ) {
          dirRef.current = candidate
          setDirection(candidate)
          return
        }
        const deg = Math.atan2(dy, dx) * (180 / Math.PI)
        const distToCurrent = angularDist(deg, SECTOR_CENTRES[dirRef.current])
        const distToCandidate = angularDist(deg, SECTOR_CENTRES[candidate])
        if (distToCurrent - distToCandidate < HYSTERESIS_DEG) return
        dirRef.current = candidate
        setDirection(candidate)
      })
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      cancelAnimationFrame(rafId.current)
    }
  }, [ref])

  return direction
}

export default function HeadFollowLogo({ alt, className, size }: HeadFollowLogoProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const direction = useHeadDirection(ref)
  return (
    <span ref={ref} className={className}>
      <img src={logoSrc(direction)} width={size} height={size} alt={alt} />
    </span>
  )
}
