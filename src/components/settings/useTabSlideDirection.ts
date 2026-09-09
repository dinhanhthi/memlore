import { useEffect, useRef, useState } from 'react'

/// `useTabSlideDirection` — tracks tab transitions so the newly active panel
/// can slide in from the correct side.
///
/// Returns the slide direction for the *current* active tab:
///   - 'right' — user moved forward (new tab is to the right of the previous)
///   - 'left'  — user moved backward
///   - null    — initial mount (no animation), reduces flash on first render
///
/// Pair with `tab-slide-in-right` / `tab-slide-in-left` CSS classes defined in
/// `src/styles/globals.css`. Animations are auto-disabled by the global
/// reduced-motion rule.
export function useTabSlideDirection<T extends string>(
  tabs: readonly T[],
  activeId: T,
): 'left' | 'right' | null {
  const prevIdRef = useRef<T>(activeId)
  const [direction, setDirection] = useState<'left' | 'right' | null>(null)

  useEffect(() => {
    if (prevIdRef.current === activeId) return
    const prevIdx = tabs.indexOf(prevIdRef.current)
    const nextIdx = tabs.indexOf(activeId)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- direction is derived from prev/next id transitions, needs effect timing
    setDirection(nextIdx > prevIdx ? 'right' : 'left')
    prevIdRef.current = activeId
  }, [activeId, tabs])

  return direction
}
