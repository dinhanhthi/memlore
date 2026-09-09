/**
 * Cross-version helpers for `window.matchMedia`.
 *
 * Safari < 14 (and the WKWebView shipped with macOS Catalina 10.15) does not
 * support `MediaQueryList.addEventListener('change', …)` — only the legacy
 * `addListener`. Tauri does not pin a minimum macOS version, so we keep the
 * legacy fallback for safety. Detection is feature-based, not UA-based.
 */

/** True when the OS reports `prefers-color-scheme: dark`. SSR-safe. */
export function osPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** True when the OS reports `prefers-reduced-motion: reduce`. SSR-safe. */
export function osPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Subscribe to a media-query change. Returns an unsubscribe function.
 * Uses `addEventListener('change', …)` on modern browsers and falls back
 * to the deprecated `addListener` for WebKit on macOS Catalina (Safari 13).
 *
 * `handler` receives the new `matches` boolean.
 */
export function subscribeMediaQuery(
  query: string,
  handler: (matches: boolean) => void,
): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mql = window.matchMedia(query)
  if (typeof mql.addEventListener === 'function') {
    const listener = (e: MediaQueryListEvent) => handler(e.matches)
    mql.addEventListener('change', listener)
    return () => mql.removeEventListener('change', listener)
  }
  // Legacy Safari < 14 / Catalina WebKit fallback
  const legacyListener = (e: MediaQueryListEvent) => handler(e.matches)
  mql.addListener(legacyListener)
  return () => {
    mql.removeListener(legacyListener)
  }
}
