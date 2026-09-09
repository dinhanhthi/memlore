import { useEffect, useState } from 'react'
import { osPrefersReducedMotion, subscribeMediaQuery } from '../lib/media-query'
import { useUiStore } from '../stores/uiStore'

/**
 * Side-effect-free reader for "should motion be reduced?".
 *
 * Unlike {@link useReducedMotion}, this hook ONLY computes the boolean — it
 * does NOT touch the `reduce-motion` class on `document.documentElement`.
 * That DOM side effect is owned exclusively by `App.tsx` (the single mount of
 * `useReducedMotion`), which applies/removes the class for the whole document.
 *
 * Use this from nested components (e.g. the `ThinkingOrb` adapter, which can
 * mount/unmount frequently as loading states toggle) that need to *react* to
 * the reduced-motion preference without stealing ownership of the global
 * class. Without this, a transient component unmounting would run the
 * `useReducedMotion` cleanup and strip the class while the app still wants it.
 *
 * Sources combined (matching `useReducedMotion`'s logic):
 * 1. the user's explicit in-app toggle (`uiStore.reducedMotion`), and
 * 2. the OS `prefers-reduced-motion: reduce` media query.
 */
export function usePrefersReducedMotion(): boolean {
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const [osPrefersReduced, setOsPrefersReduced] = useState<boolean>(() => osPrefersReducedMotion())

  useEffect(() => {
    return subscribeMediaQuery('(prefers-reduced-motion: reduce)', setOsPrefersReduced)
  }, [])

  return reducedMotion || osPrefersReduced
}
