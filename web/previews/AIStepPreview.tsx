import { OnboardingWizard } from '../../src/components/onboarding/OnboardingWizard'
import type { Stage } from '../../src/components/onboarding/steps/AIStep'
import { WindowDragRegion } from '../../src/components/layout/WindowDragRegion'

interface Props {
  initialStage?: Stage
}

/**
 * Renders the real OnboardingWizard opened straight at its AI step (`Step 4 of
 * 4`), with AIStep started at the selected sub-stage. Everything on screen —
 * the step indicator, the AI sticker, the card chrome — comes from the actual
 * wizard components, so this stays a faithful mirror of the real app rather
 * than a hand-assembled lookalike.
 */
export function AIStepPreview({ initialStage = 'enable' }: Props) {
  return (
    <>
      <WindowDragRegion />
      <OnboardingWizard initialStep="ai" initialAiStage={initialStage} />
    </>
  )
}
