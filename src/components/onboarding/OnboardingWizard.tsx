import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { AuthPageCard } from '../common/AuthPageCard'
import { useOnboardingWizard, type OnboardingStep } from '../../hooks/useOnboardingWizard'
import { JournalStep, type JournalStepHandle } from './steps/JournalStep'
import { ThemeStep } from './steps/ThemeStep'
import { DriveStep } from './steps/DriveStep'
import { AIStep, type Stage as AIStage } from './steps/AIStep'

// Countable steps shown in the "Step X of Y" indicator. Interface language is
// chosen earlier, before the vault exists (on the welcome/choose-mode screen),
// so it is not a wizard step. `done` is a transient exit state (the store's
// `pending` flips to false and App.tsx re-renders away from the wizard before
// it's ever painted) so it's excluded too.
const STEP_INDEX: Record<Exclude<OnboardingStep['kind'], 'done'>, number> = {
  theme: 1,
  journal: 2,
  drive: 3,
  ai: 4,
}
const TOTAL_STEPS = 4

// Decorative sticker shown at the top of each wizard step. theme + journal
// share the "customizable" sticker; drive gets "sync"; ai gets its own.
const STEP_STICKER: Record<Exclude<OnboardingStep['kind'], 'done'>, string> = {
  theme: '/stickers/sticker-customizable.png',
  journal: '/stickers/sticker-customizable.png',
  drive: '/stickers/sticker-sync.png',
  ai: '/stickers/sticker-ai.png',
}

// Steps that are optional and show a Skip button. `theme` always has a default,
// so it doesn't need Skip; `journal` is mandatory. `ai` is also optional but
// is deliberately excluded here — AIStep drives its own internal sub-stage
// navigation (including its own "No" / "Skip embedding" actions) and the shell
// suppresses its footer Next/Skip for this step entirely; see the footer
// render below. For `drive`, Skip is further gated on `driveConnected` so it
// disappears once Google Drive is connected.
const SKIPPABLE_STEPS: OnboardingStep['kind'][] = ['drive']

interface OnboardingWizardProps {
  /** Wizard step to open on first mount (defaults to `theme`). Only used by
   *  the web preview harness to deep-link straight to a step — the real
   *  post-setup flow always enters at `theme`. */
  initialStep?: OnboardingStep['kind']
  /** Sub-stage to open the AI step at (only meaningful with
   *  `initialStep="ai"`). Preview-harness only; forwarded to `AIStep`. */
  initialAiStage?: AIStage
}

export function OnboardingWizard({ initialStep, initialAiStage }: OnboardingWizardProps = {}) {
  const { t } = useTranslation('auth')
  const journalStepRef = useRef<JournalStepHandle>(null)
  // Starts false: the journal step's own effect corrects this on mount
  // (it starts ready since the name field is prefilled), but defaulting to
  // false here means Next can never be clicked before that confirmation
  // lands, which also covers the brief window while useJournals() is still
  // fetching the existing journal list on a resumed wizard.
  const [journalReady, setJournalReady] = useState(false)
  const [isAdvancing, setIsAdvancing] = useState(false)
  // Whether AIStep has moved past its `enable` intro — drives the AI step's
  // indicator suffix (see `indicatorLabel` below).
  const [aiPastIntro, setAiPastIntro] = useState(false)
  // Drive is optional, but once connected "Skip for now" is meaningless —
  // hide it and leave Next as the only forward action. Also fed into the
  // wizard hook so finishing with Drive linked arms the setup-sync
  // celebration (footer-oriented first-sync copy) instead of the generic
  // welcome.
  const [driveConnected, setDriveConnected] = useState(false)
  // Also hide "Skip for now" while a connect is in flight — skipping past a
  // connect the user just started would be a trap (the flow finishes in the
  // background). DriveStep reports this via `onBusyChange`.
  const [driveBusy, setDriveBusy] = useState(false)
  const { step, next, skip, back } = useOnboardingWizard(initialStep, { driveConnected })

  if (step.kind === 'done') return null

  const current = STEP_INDEX[step.kind]
  const stepIndicator = t('onboarding.step_indicator', { current, total: TOTAL_STEPS })
  // The AI step's `enable` intro shows a big "Set up AI" title of its own, so
  // the indicator stays plain there; the deeper sub-stages have no title, so
  // the indicator carries it inline, e.g. "Step 4 of 4 - Set up AI". AIStep
  // reports which side of that boundary it's on via `onPastIntroChange`.
  const indicatorLabel =
    step.kind === 'ai' && aiPastIntro
      ? `${stepIndicator} - ${t('onboarding.ai.title')}`
      : stepIndicator
  // `theme` is the first wizard step; there's nowhere to go back to (the
  // vault is already created), so Back is hidden on it.
  const isFirstStep = step.kind === 'theme'
  // AIStep owns its own forward navigation (including reaching `done`) via
  // the `onComplete` callback below — the shell's footer Next/Skip never
  // render for this step. AIStep also owns Back: it walks its own internal
  // sub-stages and only calls back to the shell's `back()` (via `onExitStep`)
  // once it's already at its first sub-stage, so the whole footer row
  // (Back included) is suppressed too — otherwise two Back buttons would
  // be visible at once.
  const showFooter = step.kind !== 'ai'
  const canSkip = SKIPPABLE_STEPS.includes(step.kind) && !driveConnected && !driveBusy
  const nextDisabled = isAdvancing || (step.kind === 'journal' && !journalReady)

  // The journal step must persist (create or rename) before the wizard
  // advances — see JournalStep's doc comment for why that happens via this
  // imperative commit() rather than a mount effect.
  const handleNext = async () => {
    try {
      if (step.kind === 'journal') {
        setIsAdvancing(true)
        try {
          const committed = await journalStepRef.current?.commit()
          if (!committed) return
        } finally {
          setIsAdvancing(false)
        }
      }
      next()
    } catch {
      // commit() already catches its own errors and surfaces them inline;
      // this is a safety net so `void handleNext()` never leaks an
      // unhandled promise rejection if something still throws.
    }
  }

  return (
    <AuthPageCard className="max-w-180 p-8">
      <p className="text-fg-muted mb-4 text-center text-xs font-medium">{indicatorLabel}</p>

      {/* The AI step's deeper sub-stages (everything after the `enable` intro)
          drop the sticker — they're a dense one-question-at-a-time form and the
          decorative logo just steals vertical space. The `enable` intro keeps
          it, consistent with the other steps. */}
      {!(step.kind === 'ai' && aiPastIntro) && (
        <img
          src={STEP_STICKER[step.kind]}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="mx-auto mb-4 block h-24 w-auto shrink-0"
        />
      )}

      {/* The AI step renders no shell header — its title lives in the indicator
          above and each sub-stage supplies its own context (see AIStep). */}
      {step.kind !== 'ai' && (
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          {step.kind === 'journal' && (
            <>
              <h1 className="font-title text-fg text-2xl font-bold">
                {t('onboarding.journal.title')}
              </h1>
              <p className="text-fg-muted max-w-sm text-sm">
                {t('onboarding.journal.explanation')}
              </p>
            </>
          )}
          {step.kind === 'theme' && (
            <>
              <h1 className="font-title text-fg text-2xl font-bold">
                {t('onboarding.theme.title')}
              </h1>
              <p className="text-fg-muted max-w-sm text-sm">{t('onboarding.theme.explanation')}</p>
            </>
          )}
          {step.kind === 'drive' && (
            <>
              <h1 className="font-title text-fg text-2xl font-bold">
                {t('onboarding.drive.title')}
              </h1>
              <p className="text-fg-muted max-w-sm text-sm">{t('onboarding.drive.explanation')}</p>
            </>
          )}
        </div>
      )}

      <div className="">
        {step.kind === 'journal' && (
          <JournalStep ref={journalStepRef} onReadyChange={setJournalReady} />
        )}
        {step.kind === 'theme' && <ThemeStep />}
        {step.kind === 'drive' && (
          <DriveStep onConnectedChange={setDriveConnected} onBusyChange={setDriveBusy} />
        )}
        {step.kind === 'ai' && (
          <AIStep
            onComplete={next}
            onExitStep={back}
            onPastIntroChange={setAiPastIntro}
            initialStage={initialAiStage}
          />
        )}
      </div>

      {showFooter && (
        <div className="mt-8 flex items-center justify-between gap-2">
          {/* Back is hidden on the first wizard step (theme) — the vault is
              already created, so there's nowhere to go back to. An empty
              spacer keeps Next right-aligned via justify-between. */}
          {isFirstStep ? (
            <div />
          ) : (
            <Button variant="ghost" size="md" onClick={back}>
              {t('onboarding.back')}
            </Button>
          )}

          <div className="flex items-center gap-2">
            {canSkip && (
              <Button variant="ghost" size="md" onClick={skip}>
                {t('onboarding.skip')}
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              onClick={() => void handleNext()}
              disabled={nextDisabled}
              loading={isAdvancing}
            >
              {t('onboarding.next')}
            </Button>
          </div>
        </div>
      )}
    </AuthPageCard>
  )
}
