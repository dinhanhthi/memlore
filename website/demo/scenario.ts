import { getScenario } from '../../web/scenarios'
import { setActiveScenario } from '../../web/mocks/activeScenario'
import { useUiStore } from '../../src/stores/uiStore'
import { makeDefaultTab, markLaunchViewApplied, useTabStore } from '../../src/stores/tabStore'
import { useOnboardingStore } from '../../src/stores/onboardingStore'
import { useSecondLockStore } from '../../src/stores/secondLockStore'
import { useInvisibleLockStore } from '../../src/stores/invisibleLockStore'
import { onDemoPersistHydrated } from './persist'
import { resetDemo } from './backend'

function applyDemoSeed() {
  const tab = {
    ...makeDefaultTab(),
    activeView: 'entries' as const,
    selectedEntryId: 'entry-0001',
  }
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
  markLaunchViewApplied()
  useUiStore.setState({
    theme: 'dark',
    designSystem: 'clay',
    uiLanguage: 'en',
    // Ollama is keyless; without this the generation slot looks disconnected
    // and Daily Chat New/Send stay disabled in the guided demo.
    addedProviders: ['ollama'],
  })
  useOnboardingStore.setState({ pending: false, celebrationPending: false })
  useSecondLockStore.setState({ isEnabled: true, showExistence: true, isSessionUnlocked: false })
  useInvisibleLockStore.setState({ activeVaultId: null })
}

export function bootstrapDemo() {
  resetDemo()
  const scenario = getScenario('ai-connected')!
  setActiveScenario(scenario)
  scenario.seedStores?.()
  applyDemoSeed()
  onDemoPersistHydrated(applyDemoSeed)
}
