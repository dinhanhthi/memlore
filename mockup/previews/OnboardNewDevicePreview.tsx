import { OnboardNewDeviceScreen } from '../../src/components/auth/OnboardNewDeviceScreen'
import { AuthPageCard } from '../../src/components/common/AuthPageCard'
import { WindowDragRegion } from '../../src/components/layout/WindowDragRegion'
import { WEB_PREVIEW_ONBOARD_SESSION_ID } from '../scenarios/auth'

type Step = 'passphrase' | 'unlock_method' | 'password'

interface Props {
  initialStep?: Step
}

export function OnboardNewDevicePreview({ initialStep = 'passphrase' }: Props) {
  return (
    <>
      <WindowDragRegion />
      <AuthPageCard className="max-w-130 p-8">
        <OnboardNewDeviceScreen
          initialStep={initialStep}
          sessionId={WEB_PREVIEW_ONBOARD_SESSION_ID}
          onCompleted={() => {
            console.info('[web-preview] OnboardNewDeviceScreen completed')
          }}
          onCancel={() => {
            console.info('[web-preview] OnboardNewDeviceScreen cancelled')
          }}
        />
      </AuthPageCard>
    </>
  )
}
