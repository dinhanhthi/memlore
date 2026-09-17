import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/fraunces/index.css'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '@fontsource-variable/baloo-2/index.css'
import { terms } from '../content'
import LegalPage from './LegalPage'
import '../styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LegalPage doc={terms} />
  </StrictMode>,
)
