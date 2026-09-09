import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import 'leaflet/dist/leaflet.css'
import './styles/fonts'
import './styles/globals.css'
// Side-effect import — initialises i18next before any component renders so
// `t()` calls during the first paint resolve against the seeded resources.
import './lib/i18n'
import App from './App.tsx'
import { queryClient, bridgeWindowEvents } from './lib/queryClient'

function QueryBridge() {
  useEffect(() => bridgeWindowEvents(queryClient), [])
  return null
}

// WKWebView belt-and-suspenders. Two upstream guards do most of the work:
//   1. `html { overflow: hidden }` in globals.css blocks user-initiated scroll.
//   2. Every DOM `.focus()` in the app passes `{ preventScroll: true }` so
//      WebKit's implicit scroll-into-view never walks the ancestor chain.
// This listener is the third layer — defensive only — for any rogue
// programmatic scroll that sneaks past (e.g. TipTap / ProseMirror focus,
// future code that forgets `preventScroll`). Resets window scroll so the
// TitleBar never drifts off-screen. Do NOT remove the CSS / preventScroll
// fixes and rely solely on this listener — it fires after the layout pass
// and may produce a single-frame jitter on its own.
window.addEventListener(
  'scroll',
  () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0)
    }
  },
  { passive: true },
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <QueryBridge />
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
