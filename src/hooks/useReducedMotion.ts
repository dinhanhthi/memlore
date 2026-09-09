import { useEffect, useState } from 'react'
import { useUiStore } from '../stores/uiStore'
import { osPrefersReducedMotion, subscribeMediaQuery } from '../lib/media-query'

/**
 * Applies reduced-motion behaviour based on either the user's explicit store
 * toggle OR the OS "prefers-reduced-motion: reduce" media query.
 *
 * When either is true, the class `reduce-motion` is added to
 * `document.documentElement`. The CSS rule `.reduce-motion *` in globals.css
 * mirrors the `@media (prefers-reduced-motion: reduce)` block, giving
 * defense-in-depth: OS preference still works even if JS fails.
 *
 * The class is removed on unmount so consumers nested anywhere in the tree
 * don't leak motion-disable state past their lifetime.
 *
 * Returns `{ prefersReducedMotion }` — true when either source is active.
 */
export function useReducedMotion() {
  const reducedMotion = useUiStore((s) => s.reducedMotion)

  const [osPrefersReduced, setOsPrefersReduced] = useState<boolean>(() => osPrefersReducedMotion())

  // Subscribe to OS preference changes (uses addEventListener with legacy
  // addListener fallback for WebKit on macOS Catalina).
  useEffect(() => {
    return subscribeMediaQuery('(prefers-reduced-motion: reduce)', setOsPrefersReduced)
  }, [])

  // Apply / remove the class on the document root. Cleanup ensures the class
  // doesn't outlive the hook (matters if the hook is ever moved off App root).
  useEffect(() => {
    const active = reducedMotion || osPrefersReduced
    document.documentElement.classList.toggle('reduce-motion', active)
    return () => {
      document.documentElement.classList.remove('reduce-motion')
    }
  }, [reducedMotion, osPrefersReduced])

  return { prefersReducedMotion: reducedMotion || osPrefersReduced }
}
