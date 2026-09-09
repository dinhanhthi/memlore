import type { DesignSystem } from './designSystem'

/**
 * Window chrome constants shared between the TitleBar and the
 * WindowDragRegion overlay used on auth screens.
 *
 * Tabs fill the full titlebar row height (no vertical padding / radius) in
 * Signature/Clean; Clay uses taller inset pill tabs, so its row is taller.
 * The native macOS traffic lights are re-centred by the Rust side
 * (`commands::window_chrome`) whenever `useTitlebarRowHeightSync` reports a new row
 * height — `tauri.conf.json` no longer pins `trafficLightPosition`.
 *
 * Consumers: `TitleBar.tsx` row height, `WindowDragRegion.tsx` overlay
 * height, `useLogoDirection.ts` titlebar-row hit test. If you change a
 * value, retest the lock screen AND the unlocked shell in every skin. A
 * mismatch makes the lock screen silently un-draggable in the gap above or
 * below the native traffic-light cluster.
 */
export function titlebarRowHeight(designSystem: DesignSystem): number {
  return designSystem === 'clay' ? 44 : 36
}
