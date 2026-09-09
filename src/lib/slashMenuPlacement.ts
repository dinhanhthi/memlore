/** Gap between the caret and the slash menu, in CSS pixels. */
export const SLASH_MENU_GAP = 6

/** Default cap — matches Tailwind `max-h-70` (17.5rem). */
export const SLASH_MENU_MAX_HEIGHT = 280

export interface SlashMenuCaret {
  top: number
  bottom: number
  left: number
}

export interface SlashMenuViewport {
  width: number
  height: number
}

export interface SlashMenuPlacement {
  placement: 'below' | 'above'
  top: number | null
  bottom: number | null
  left: number
  maxHeight: number
}

/**
 * Keep the slash popover inside the viewport. `html`/`body` are overflow-hidden
 * in WKWebView, so a menu that hangs past the window edge is clipped with no
 * way to scroll to the last rows.
 */
export function placeSlashMenu({
  caret,
  viewport,
  preferredMaxHeight = SLASH_MENU_MAX_HEIGHT,
}: {
  caret: SlashMenuCaret
  viewport: SlashMenuViewport
  preferredMaxHeight?: number
}): SlashMenuPlacement {
  const spaceBelow = viewport.height - caret.bottom - SLASH_MENU_GAP
  const spaceAbove = caret.top - SLASH_MENU_GAP
  const placement: 'below' | 'above' = spaceBelow >= spaceAbove ? 'below' : 'above'

  if (placement === 'below') {
    return {
      placement,
      top: caret.bottom + SLASH_MENU_GAP,
      bottom: null,
      left: caret.left,
      maxHeight: Math.max(0, Math.min(preferredMaxHeight, spaceBelow)),
    }
  }

  return {
    placement,
    top: null,
    bottom: viewport.height - caret.top + SLASH_MENU_GAP,
    left: caret.left,
    maxHeight: Math.max(0, Math.min(preferredMaxHeight, spaceAbove)),
  }
}
