import { OnboardingWizard } from '../../src/components/onboarding/OnboardingWizard'
import { WindowDragRegion } from '../../src/components/layout/WindowDragRegion'

/**
 * Renders the post-setup onboarding wizard (theme → journal → Drive → AI) on
 * its own, bypassing the real App.tsx gate (which needs an unlocked vault and
 * the `pending` flag). Backed by the scenario's `invoke` mocks so each step's
 * UI can be inspected without running the whole first-run flow.
 *
 * Note: the interface-language screen is NOT part of this wizard — it lives on
 * the welcome/choose-mode screen (see the `onboarding` scenario), shown before
 * the vault exists.
 */
export function OnboardingWizardPreview() {
  return (
    <>
      <WindowDragRegion />
      <OnboardingWizard />
    </>
  )
}
