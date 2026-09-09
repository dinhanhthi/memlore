import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useUiStore } from '../stores/uiStore'
import { titlebarRowHeight } from '../lib/windowChrome'

/**
 * Report the active skin's titlebar row height to the Rust side, which
 * re-centres the native macOS traffic lights in it (`set_titlebar_row_height`
 * in `commands/window_chrome.rs`). Mount once (App.tsx) — `useDesignSystem`
 * is mounted in several components, so the IPC does not live there.
 *
 * The rejection is swallowed on purpose: outside Tauri (web preview) there is
 * nothing to move. Rust setup seeds the last persisted row height from
 * `{app_data}/titlebar_row_height` before the webview loads, so Clay's 44px
 * row is already applied on launch.
 */
export function useTitlebarRowHeightSync() {
  const designSystem = useUiStore((s) => s.designSystem)
  useEffect(() => {
    void Promise.resolve(
      invoke('set_titlebar_row_height', { height: titlebarRowHeight(designSystem) }),
    ).catch(() => {})
  }, [designSystem])
}
