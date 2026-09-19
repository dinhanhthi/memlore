import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import LandingPage from './LandingPage'
import ChangelogPage from './changelog/ChangelogPage'
import LegalPage from './legal/LegalPage'
import aboutMarkdown from './legal/about.md?raw'
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
    case 'about':
      return <LegalPage kind="about" source={aboutMarkdown} />
    case 'home':
      return <LandingPage />
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
)
