/**
 * Layout contract for the entry-card "Set location" submenu.
 *
 * WKWebView can resolve `flex-1` (`flex: 1 1 0%`) + `min-h-0` to a 0-height
 * scrollport when the parent column has indefinite (auto) height. Overflow
 * still paints; hit-testing uses the collapsed box, so alias clicks miss.
 * Scroll on the pane itself — never nest that scroller.
 */

/** Outer location pane. Must be the scrollport (`overflow-y-auto`). */
export const LOCATION_SUBMENU_PANE_CLASS =
  'border-border-default bg-elevated max-h-80 w-max max-w-70 overflow-y-auto rounded-xl border p-1 shadow-lg'
