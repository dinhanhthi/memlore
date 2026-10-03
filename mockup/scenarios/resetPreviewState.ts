import { queryClient } from '../../src/lib/queryClient'
import i18n from '../../src/lib/i18n'
import { useForceRePairStore } from '../../src/hooks/useForceRePair'
import { useRotationResumeStore } from '../../src/hooks/useRotationResume'
import { __clearStatsCache } from '../../src/hooks/useStats'
import { useSettingsStore } from '../../src/stores/settingsStore'
import { useUiStore } from '../../src/stores/uiStore'
import { useOnboardingStore } from '../../src/stores/onboardingStore'
import { __resetSyncStoreForTests } from '../../src/stores/syncStore'
import { resetAiSettingsStore } from '../../src/stores/aiSettingsStore'
import { resetDailyChatDocs } from '../mocks/dailyChatDocs'
import { resetMediaUploadLimits } from '../mocks/mediaUploadLimits'

/**
 * Reset module-level client state that survives an <App key={…}> remount.
 * A full page reload does this implicitly; scenario switches must mimic it so
 * auth gates (lock screen, force-re-pair, onboarding) reflect the new mocks.
 */
export function resetPreviewState(): void {
  useSettingsStore.setState({
    isLocked: false,
    encryptionMode: null,
    isBiometricEnabled: false,
  })

  useForceRePairStore.getState().clearForceRePair()
  useRotationResumeStore.getState().clearResumeRequired()
  useUiStore.getState().setPendingRotationPhrase(null)
  useOnboardingStore.setState({ pending: false, celebrationPending: false })

  resetAiSettingsStore()
  resetMediaUploadLimits()
  resetDailyChatDocs()
  __resetSyncStoreForTests()
  queryClient.clear()
  // useStats keeps its own module-scoped cache (separate from react-query);
  // clear it so stats data from a previous scenario doesn't mask the Loading
  // scenario's pending overrides.
  __clearStatsCache()
  // Keep language deterministic across scenario switches (e2e may flip VI mid-test).
  useUiStore.getState().setUiLanguage('en')
  void i18n.changeLanguage('en')
}
