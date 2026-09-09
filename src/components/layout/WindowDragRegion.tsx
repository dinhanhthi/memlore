import { getCurrentWindow } from '@tauri-apps/api/window'
import { titlebarRowHeight } from '../../lib/windowChrome'
import { useUiStore } from '../../stores/uiStore'

/**
 * Invisible drag strip that sits at the top of the window and makes the
 * empty area around the macOS traffic-light buttons draggable.
 *
 * Used on screens where the full <TitleBar/> doesn't mount (LockScreen,
 * SetPasswordScreen). Without this, the user can't move the window during
 * password entry — WKWebView doesn't honor `data-tauri-drag-region` or
 * `-webkit-app-region: drag` reliably, so we wire `startDragging()` from
 * `@tauri-apps/api/window` on mousedown.
 *
 * Requires the `core:window:allow-start-dragging` capability permission.
 */
export function WindowDragRegion() {
  const designSystem = useUiStore((s) => s.designSystem)
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('a, button, input, select, textarea, [role="button"]')) {
      return
    }
    void getCurrentWindow()
      .startDragging()
      .catch((err: unknown) => {
        if (import.meta.env.DEV) {
          console.warn('[WindowDragRegion] startDragging() rejected:', err)
        }
      })
  }

  return (
    <div
      data-testid="window-drag-region"
      onMouseDown={handleMouseDown}
      aria-hidden="true"
      // Shared helper with TitleBar — a mismatch makes the lock screen
      // silently un-draggable in the gap around the native traffic lights.
      className="fixed top-0 right-0 left-0 z-1000 bg-transparent"
      style={{ height: titlebarRowHeight(designSystem) }}
    />
  )
}
