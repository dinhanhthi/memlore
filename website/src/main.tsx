import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/fraunces/index.css'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '@fontsource-variable/baloo-2/index.css'
import LandingPage from './LandingPage'
import ChangelogPage from './changelog/ChangelogPage'
import LegalPage from './legal/LegalPage'
import privacyMarkdown from './legal/privacy.md?raw'
import termsMarkdown from './legal/terms.md?raw'
import { useRoute } from './router'
import './styles.css'

function Site() {
  switch (useRoute()) {
    case 'changelog':
      return <ChangelogPage />
    case 'privacy':
      return <LegalPage kind="privacy" source={privacyMarkdown} />
    case 'terms':
      return <LegalPage kind="terms" source={termsMarkdown} />
    // Phase 2 adds the About page; until then `/about` shows the landing page.
    case 'home':
    case 'about':
      return <LandingPage />
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
)
