import { useLayoutEffect, useState } from 'react'

/**
 * Id of the layout card that hosts body-scoped overlays — the app minus
 * titlebar, sidebar and footer. Dialogs measure this card and pin a
 * `position: fixed` layer to its viewport box (portaled to `document.body`
 * so z-index still beats FloatingPortal popovers). Defined in this leaf
 * module so layout, media, and common/ do not import each other.
 */
export const BODY_OVERLAY_HOST_ID = 'xj-body-overlay-host'

export interface OverlayHostBox {
  top: number
  left: number
  width: number
  height: number
}

export function getOverlayHostElement(): HTMLElement | null {
  return document.getElementById(BODY_OVERLAY_HOST_ID)
}

/** Viewport box of the body card, or `null` when the shell is not mounted
 *  (lock screen, onboarding, isolated tests). */
export function measureOverlayHost(): OverlayHostBox | null {
  const host = getOverlayHostElement()
  if (!host) return null
  const rect = host.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

/** Subscribe to the body-card box so overlays stay pinned through sidebar
 *  collapse and window resize. `null` means fall back to full-window. */
export function useOverlayHostBox(): OverlayHostBox | null {
  const [box, setBox] = useState<OverlayHostBox | null>(measureOverlayHost)

  useLayoutEffect(() => {
    const host = getOverlayHostElement()
    if (!host) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- layout measurement after commit
      setBox(null)
      return
    }

    const update = () => setBox(measureOverlayHost())
    update()
    const ro = new ResizeObserver(update)
    ro.observe(host)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  return box
}
