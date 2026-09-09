export const PANEL_WIDTH = 224 // w-56 = 14rem
export const MIN_VISIBLE_HEIGHT = 40

export interface PanelPos {
  x: number
  y: number
}

export interface ViewportSize {
  width: number
  height: number
}

export function clampPanelPos(pos: PanelPos, viewport: ViewportSize): PanelPos {
  return {
    x: Math.max(0, Math.min(viewport.width - PANEL_WIDTH, pos.x)),
    y: Math.max(0, Math.min(viewport.height - MIN_VISIBLE_HEIGHT, pos.y)),
  }
}

export function defaultPanelPos(viewport: ViewportSize): PanelPos {
  return clampPanelPos({ x: viewport.width - PANEL_WIDTH - 12, y: 12 }, viewport)
}
