/**
 * Returns true when the click event carries the "open in new tab" modifier:
 *   - macOS  → only ⌘ (Cmd / Meta).
 *   - others → Ctrl or Meta.
 *
 * Ctrl is intentionally NOT honored on macOS because the OS treats
 * Ctrl+click as a secondary (right) click — accepting it here would
 * double-fire alongside the synthesized `contextmenu` event.
 */
export function isNewTabModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
  return isMac ? e.metaKey : e.metaKey || e.ctrlKey
}

/**
 * Middle mouse button. Matches the browser convention of opening a link in
 * a new background tab. React's MouseEvent uses `button === 1` for middle.
 */
export function isMiddleClick(e: { button: number }): boolean {
  return e.button === 1
}
