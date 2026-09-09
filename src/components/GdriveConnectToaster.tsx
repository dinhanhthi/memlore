import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { providerLabel } from '../lib/providerLabel'
import { toast } from '../lib/toast'
import { shouldSurfaceConnectResult, useGdriveConnectStore } from '../stores/gdriveConnectStore'
import { useOnboardingStore } from '../stores/onboardingStore'

/**
 * Surfaces the result of a *background* cloud connect as a toast, once
 * the user has left the onboarding Drive step.
 *
 * Mounted in the main app shell, which renders only after onboarding finishes.
 * So a terminal status observed here means the connect resolved while the user
 * was on a later onboarding step or already in the app — the case where
 * DriveStep is no longer around to show its inline result.
 *
 * Timing: finishing onboarding arms the one-shot `OnboardingCelebrationModal`
 * (`celebrationPending`) in the same action that mounts this shell. That modal
 * is the natural "everything's done" surface and would eclipse a 2s toast — a
 * *missed failure notice* is exactly the silent bug this feature exists to
 * prevent. So the toast is deferred until the celebration is dismissed, then
 * surfaced. Fires at most once per connect: the "shown" flag lives in the
 * store (`resultAcknowledged`), NOT a per-mount ref, because this component
 * unmounts on lock and remounts on unlock (different App.tsx subtrees) while
 * the store's terminal `status` persists — a per-mount guard would re-toast on
 * every unlock. It re-evaluates when either the connect result or the
 * celebration flag changes.
 */
export function GdriveConnectToaster() {
  const { t } = useTranslation('auth')
  const { t: tSettings } = useTranslation('settings')

  useEffect(() => {
    const surface = () => {
      const { status, resultAcknowledged, acknowledgeResult, manualConnecting, target } =
        useGdriveConnectStore.getState()
      const { celebrationPending } = useOnboardingStore.getState()
      const kind = shouldSurfaceConnectResult(
        status,
        resultAcknowledged,
        celebrationPending,
        manualConnecting,
      )
      if (!kind) return
      acknowledgeResult()
      const i18nProvider = { provider: providerLabel(target?.provider ?? 'gdrive', tSettings) }
      toast(
        kind === 'success'
          ? t('onboarding.drive.connected', i18nProvider)
          : t('onboarding.drive.background_failed', i18nProvider),
      )
    }
    // Check on mount (result and/or celebration may already be settled), then
    // re-check whenever the connect result or the celebration flag changes.
    surface()
    const unsubConnect = useGdriveConnectStore.subscribe(surface)
    const unsubOnboarding = useOnboardingStore.subscribe(surface)
    return () => {
      unsubConnect()
      unsubOnboarding()
    }
  }, [t, tSettings])

  return null
}
