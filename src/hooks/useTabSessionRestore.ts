import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTabStore } from '../stores/tabStore'

/** True once `useTabStore` persist has finished reading `memlore-tabs`. */
export function useTabSessionHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useTabStore.persist.hasHydrated())

  useEffect(() => {
    const unsub = useTabStore.persist.onFinishHydration(() => {
      setHydrated(true)
    })
    if (useTabStore.persist.hasHydrated()) setHydrated(true)
    return unsub
  }, [])

  return hydrated
}

/** Force a persist write of the current tab session without touching nav history. */
export function flushTabSession(): void {
  // Seed tab must not overwrite an unread `memlore-tabs` payload.
  if (!useTabStore.persist.hasHydrated()) return
  const { tabs, activeTabId } = useTabStore.getState()
  useTabStore.setState({ tabs, activeTabId })
}

/**
 * Flush the tab session on window close, pagehide, and document hidden.
 * WKWebView often skips a disk flush if the process dies during CloseRequested.
 */
export function useFlushTabSessionOnClose(): void {
  useEffect(() => {
    let cancelled = false
    let unlistenClose: (() => void) | undefined

    void getCurrentWindow()
      .onCloseRequested(() => {
        flushTabSession()
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten()
          return
        }
        unlistenClose = unlisten
      })
      .catch(() => {
        // web mock / non-Tauri — no close event to flush on
      })

    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushTabSession()
    }

    window.addEventListener('pagehide', flushTabSession)
    document.addEventListener('visibilitychange', onHidden)

    return () => {
      cancelled = true
      window.removeEventListener('pagehide', flushTabSession)
      document.removeEventListener('visibilitychange', onHidden)
      unlistenClose?.()
    }
  }, [])
}
