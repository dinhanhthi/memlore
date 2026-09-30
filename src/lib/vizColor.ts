import { useSyncExternalStore } from 'react'

/** Series tokens the two Recharts cards paint with. */
export type VizColorName = '--color-viz-1' | '--color-viz-2'

/**
 * Resolve a viz token to the colour currently painted on `<html>`.
 *
 * Recharts copies `stroke` / `fill` onto the SVG attribute verbatim.
 * `var(--color-viz-N)` stays unresolved in the serialized markup, and the
 * PNG exporter then inlines that literal and the series exports black.
 * Reading the custom property here hands Recharts a real colour.
 *
 * Falls back to the token string only when there is no `document`
 * (non-DOM). An empty computed value is returned as-is.
 */
export function readVizColor(name: VizColorName): string {
  if (typeof document === 'undefined') return `var(${name})`
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function subscribeRootClass(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  return () => observer.disconnect()
}

/** Current series colour. Re-reads when the root class list changes
 *  (theme, design system, surface), which is what retargets these tokens. */
export function useVizColor(name: VizColorName): string {
  return useSyncExternalStore(
    subscribeRootClass,
    () => readVizColor(name),
    () => `var(${name})`,
  )
}
