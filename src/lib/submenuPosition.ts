/**
 * Compute `marginTop` so a submenu pane stays fully inside the viewport.
 * Returns `preferredMarginTop` when it already fits; otherwise clamps to
 * the nearest in-bounds value (may be negative to slide the pane up).
 */
export function clampSubmenuVerticalPosition(params: {
  anchorTop: number
  paneHeight: number
  viewportHeight: number
  padding?: number
  preferredMarginTop?: number
}): number {
  const padding = params.padding ?? 8
  const preferred = params.preferredMarginTop ?? 0
  const minMarginTop = padding - params.anchorTop
  const maxMarginTop = params.viewportHeight - padding - params.anchorTop - params.paneHeight
  return Math.max(minMarginTop, Math.min(maxMarginTop, preferred))
}
