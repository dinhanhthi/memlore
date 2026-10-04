import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import 'leaflet/dist/leaflet.css'
import '../src/styles/fonts'
import './styles.css'
import '../src/lib/i18n'
import App from '../src/App'
import { queryClient, bridgeWindowEvents } from '../src/lib/queryClient'
import { applyScenario } from './scenarios/apply'
import { defaultScenarioId, getScenario } from './scenarios/index'
import { ScenarioPicker } from './components/ScenarioPicker'
import { ComponentFileBadge } from './components/ComponentFileBadge'
import { getActiveScenario } from './mocks/activeScenario'
import { OnboardNewDevicePreview } from './previews/OnboardNewDevicePreview'
import { OnboardingWizardPreview } from './previews/OnboardingWizardPreview'
import { AIStepPreview } from './previews/AIStepPreview'
import { WelcomePreview } from './previews/WelcomePreview'
import type { Stage } from '../src/components/onboarding/steps/AIStep'
import type { Screen } from '../src/components/auth/WelcomeScreen'

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

// Resolve the initial scenario from ?scenario= URL param or localStorage.
function resolveInitialScenarioId(): string {
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get('scenario')
  if (fromUrl) return fromUrl
  return localStorage.getItem('xj-web-scenario') ?? defaultScenarioId
}

function ScenarioRoot({
  remountKey,
  activeStepId,
}: {
  remountKey: number
  activeStepId: string | null
}) {
  const preview = getActiveScenario().preview
  if (preview?.kind === 'onboard-new-device') {
    return <OnboardNewDevicePreview key={remountKey} initialStep={preview.initialStep} />
  }
  if (preview?.kind === 'onboarding-wizard') {
    return <OnboardingWizardPreview key={remountKey} />
  }
  if (preview?.kind === 'ai-step') {
    return <AIStepPreview key={remountKey} initialStage={(activeStepId as Stage) ?? undefined} />
  }
  if (preview?.kind === 'welcome') {
    return <WelcomePreview key={remountKey} initialScreen={(activeStepId as Screen) ?? undefined} />
  }
  return <App key={remountKey} />
}

/** First sub-step id for a scenario's step selector, or null when it has none. */
function defaultStepId(id: string): string | null {
  return getScenario(id)?.steps?.options[0]?.id ?? null
}

function Root() {
  const [remountKey, setRemountKey] = useState(0)
  const [activeScenarioId, setActiveScenarioId] = useState<string>(() => {
    const id = resolveInitialScenarioId()
    // Apply initial scenario without remounting (the app hasn't mounted yet).
    // Use the returned resolved id so unknown ?scenario= params fall back correctly.
    return applyScenario(id, () => {})
  })
  // Selected sub-step for scenarios that declare a step selector (AIStep
  // sub-stages, WelcomeScreen screens). Null for single-screen
  // scenarios. Routed into the preview via ScenarioRoot.
  const [activeStepId, setActiveStepId] = useState<string | null>(() =>
    defaultStepId(activeScenarioId),
  )

  function handleApply(id: string) {
    const resolved = applyScenario(id, () => setRemountKey((k) => k + 1))
    setActiveScenarioId(resolved)
    // Reset to the new scenario's first step (or clear it for single-screen ones).
    setActiveStepId(defaultStepId(resolved))
  }

  function handleSelectStep(stepId: string) {
    setActiveStepId(stepId)
    setRemountKey((k) => k + 1)
  }

  const scenario = getScenario(activeScenarioId)

  return (
    <>
      <QueryClientProvider client={queryClient}>
        <QueryBridge />
        <ScenarioRoot remountKey={remountKey} activeStepId={activeStepId} />
      </QueryClientProvider>
      <ScenarioPicker
        activeId={activeScenarioId}
        onApply={handleApply}
        steps={scenario?.steps}
        activeStepId={activeStepId}
        onSelectStep={handleSelectStep}
      />
      {scenario ? <ComponentFileBadge scenario={scenario} /> : null}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
