import { WelcomeScreen, type Screen } from '../../src/components/auth/WelcomeScreen'
import { WindowDragRegion } from '../../src/components/layout/WindowDragRegion'

interface Props {
  initialScreen?: Screen
}

/**
 * Renders WelcomeScreen standalone — identical to how App.tsx mounts it during
 * onboarding (WindowDragRegion + the screen), but with an `initialScreen`
 * deep-link so each in-place screen (language / intro / cloud-empty-prompt) can
 * be opened directly via the ScenarioPicker's step selector. The
 * `setup-wizard` and `onboard-existing` screens route to their own components
 * (covered by other scenarios) and are not exposed here.
 */
export function WelcomePreview({ initialScreen = 'language' }: Props) {
  return (
    <>
      <WindowDragRegion />
      <WelcomeScreen
        initialScreen={initialScreen}
        onSetupSuccess={() => console.info('[web-preview] WelcomeScreen setup success')}
      />
    </>
  )
}
