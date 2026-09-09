/**
 * WKWebView-safe replacement for `el.scrollIntoView({ block: 'nearest' })`.
 *
 * Native `scrollIntoView` walks every scrollable ancestor of the target,
 * and on Tauri's WKWebView that walk occasionally bubbles up to <html> /
 * <body>, shifting the document and clipping the TitleBar (see the comment
 * block in `src/styles/globals.css` for the underlying WebKit behavior).
 *
 * This helper instead scrolls only the explicit `container` — the scroll
 * never escapes the component that owns it.
 *
 * Semantics match `scrollIntoView({ block: 'nearest' })`: only scrolls
 * when `item` is outside the container's visible band, and aligns to the
 * nearest edge (top edge if scrolling up, bottom edge if scrolling down).
 */
export function scrollIntoViewNearest(container: HTMLElement, item: HTMLElement): void {
  const c = container.getBoundingClientRect()
  const i = item.getBoundingClientRect()
  if (i.top < c.top) {
    container.scrollTop += i.top - c.top
  } else if (i.bottom > c.bottom) {
    container.scrollTop += i.bottom - c.bottom
  }
}
