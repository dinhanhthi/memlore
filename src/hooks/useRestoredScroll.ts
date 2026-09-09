import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import {
  applySavedScroll,
  getTabScroll,
  isScrollPortUsable,
  setTabScroll,
} from '../lib/tabScrollPositions'

/**
 * Persist `scrollTop` for a session-only key and restore it after layout.
 * Sets `el.scrollTop` directly — never `scrollIntoView` (WKWebView).
 *
 * Restore retries via ResizeObserver when the port is hidden (`display:none`)
 * or not yet tall enough (async list / TipTap). Hidden ports never write 0
 * into the map, so keep-alive sub-tabs cannot clobber a saved position.
 */
export function useRestoredScroll(
  ref: RefObject<HTMLElement | null>,
  key: string | null,
  options?: { ready?: boolean },
): { restored: boolean } {
  const ready = options?.ready ?? true
  const [restored, setRestored] = useState(false)

  // Save the outgoing key before the restore effect runs (declaration order).
  useLayoutEffect(() => {
    return () => {
      const el = ref.current
      if (key && el && isScrollPortUsable(el)) setTabScroll(key, el.scrollTop)
    }
  }, [key, ref])

  useLayoutEffect(() => {
    if (!key || !ready) {
      setRestored(false)
      return
    }
    const el = ref.current
    if (!el) {
      setRestored(false)
      return
    }
    const saved = getTabScroll(key)
    if (saved === undefined) {
      setRestored(false)
      return
    }
    setRestored(applySavedScroll(el, saved))
  }, [key, ready, ref])

  useEffect(() => {
    if (!key || !ready) return
    const el = ref.current
    if (!el) return

    const tryRestore = () => {
      const saved = getTabScroll(key)
      if (saved === undefined) return
      if (applySavedScroll(el, saved)) setRestored(true)
    }

    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!isScrollPortUsable(el)) return
        setTabScroll(key, el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            tryRestore()
          })
        : null
    ro?.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [key, ready, ref])

  return { restored }
}
