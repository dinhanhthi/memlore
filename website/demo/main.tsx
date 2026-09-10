import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import 'leaflet/dist/leaflet.css'
import '../../src/styles/fonts'
import './styles.css'
import '../../src/lib/i18n'
import './persist'
import { bootstrapDemo } from './scenario'
import App from '../../src/App'
import { queryClient, bridgeWindowEvents } from '../../src/lib/queryClient'
import { cancelAllStreams } from './streaming'
import { connectDemoBridge } from './bridge'

// Bootstrap before mounting: the shared app receives the same seeded backend
// as the development harness, without its scenario picker or developer tools.
bootstrapDemo()
window.addEventListener('pagehide', cancelAllStreams)

export function QueryBridge() {
  useEffect(() => bridgeWindowEvents(queryClient), [])
  useEffect(connectDemoBridge, [])
  return null
}

function DemoNotice() {
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const listener = (event: Event) => setNotice(String((event as CustomEvent).detail))
    window.addEventListener('memlore-demo-notice', listener)
    return () => window.removeEventListener('memlore-demo-notice', listener)
  }, [])
  if (!notice) return null
  return (
    <aside className="demo-notice" role="status">
      <p>{notice}</p>
      <button onClick={() => setNotice('')}>Dismiss</button>
    </aside>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <QueryBridge />
      <App />
      <DemoNotice />
    </QueryClientProvider>
  </StrictMode>,
)
