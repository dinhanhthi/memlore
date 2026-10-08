import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import 'leaflet/dist/leaflet.css'
import '../src/styles/fonts'
import './styles.css'
import '../src/lib/i18n'
import App from '../src/App'
import { queryClient, bridgeWindowEvents } from '../src/lib/queryClient'
import { useCapabilitiesStore } from '../src/stores/capabilitiesStore'
import { getCachedWriteFlag, onWriteFlagChange } from './src/backend/config'
import { CAPABILITIES_EVENT } from './src/backend/commands/sync'
import { listen } from './src/tauri/event'

// Fail-closed: the editor is read-only until the Worker's write flag says otherwise.
const { setWrites } = useCapabilitiesStore.getState()
setWrites(getCachedWriteFlag())
onWriteFlagChange(setWrites)
// Desktop-derived capabilities (outbox v2, month index): false until a pull reports them.
const { setWebCapabilities } = useCapabilitiesStore.getState()
void listen<unknown>(CAPABILITIES_EVENT, (e) => setWebCapabilities(e.payload))

function QueryBridge() {
  useEffect(() => bridgeWindowEvents(queryClient), [])
  return null
}

// Mirror the scroll-reset guard from src/main.tsx
window.addEventListener(
  'scroll',
  () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
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
