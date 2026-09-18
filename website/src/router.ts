import { useEffect, useRef, useState } from 'react'

export type RouteName = 'home' | 'changelog' | 'privacy' | 'terms' | 'about'

export const ROUTES: Record<RouteName, { path: string; title: string }> = {
  home: { path: '/', title: 'Memlore — A little life. A lasting story.' },
  changelog: { path: '/changelog', title: 'Memlore — Changelog' },
  privacy: { path: '/privacy', title: 'Memlore — Privacy Policy' },
  terms: { path: '/terms', title: 'Memlore — Terms of Service' },
  about: { path: '/about', title: 'Memlore — About' },
}

const ROUTE_BY_PATH = new Map<string, RouteName>(
  (Object.keys(ROUTES) as RouteName[]).map((name) => [ROUTES[name].path, name]),
)

/** `/privacy`, `/privacy.html` and `/privacy/` are the same route; anything unknown is home. */
export function normalizePath(pathname: string): RouteName {
  const path = pathname
    .replace(/index\.html$/, '')
    .replace(/\.html$/, '')
    .replace(/\/+$/, '')
  if (path === '') return 'home'
  return ROUTE_BY_PATH.get(path) ?? 'home'
}

export function useRoute(): RouteName {
  const [route, setRoute] = useState<RouteName>(() => normalizePath(window.location.pathname))
  // Holds the route whose focus move already happened. Compared by value rather than a
  // "first run" boolean because StrictMode remounts effects while keeping refs.
  const focused = useRef<RouteName>(route)

  useEffect(() => {
    document.title = ROUTES[route].title
    if (focused.current === route) return
    focused.current = route
    // A page load reset focus to the document start and made a screen reader announce
    // the new title; swapping the tree does neither, and `privacy -> terms` renders the
    // same component so focus would stay on the link that was clicked. `preventScroll`
    // leaves scrolling to the click handler below — otherwise the two fight under
    // `html { scroll-behavior: smooth }`.
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [route])

  useEffect(() => {
    const onPopState = () => setRoute(normalizePath(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a') : null
      if (!anchor || anchor.hasAttribute('target') || anchor.hasAttribute('download')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      const next = normalizePath(url.pathname)
      // A link to the route we are already on (e.g. `/#demo` while on `/`) is a native
      // fragment jump the browser handles without a reload — never intercept it.
      if (next === route) return

      event.preventDefault()
      history.pushState(null, '', anchor.href)
      setRoute(next)
      const hash = url.hash.slice(1)
      if (hash) {
        // The target element only exists after the new route has rendered.
        requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView())
      } else {
        window.scrollTo(0, 0)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [route])

  return route
}
