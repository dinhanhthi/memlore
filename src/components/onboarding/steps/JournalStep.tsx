import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useJournals } from '../../../hooks/useJournals'
import {
  getRandomJournalColor,
  PRESET_COLORS,
  resolveOnboardingJournalColor,
} from '../../../lib/journalColors'
import { cn } from '../../../lib/cn'
import { TextInput } from '../../common/TextInput'

export interface JournalStepHandle {
  /**
   * Create the first journal, or rename the existing one if the wizard was
   * resumed. Returns false (without persisting) if the name is blank — the
   * caller must not advance the wizard in that case.
   */
  commit: () => Promise<boolean>
}

interface JournalStepProps {
  /** Fires whenever readiness to advance changes (non-blank name, journal
   * list loaded, no commit in flight) so the wizard shell can drive its
   * footer Next button. */
  onReadyChange: (ready: boolean) => void
}

/// `JournalStep` — names and colors the first journal. Persistence happens
/// only via the imperative `commit()` handle, invoked by the wizard shell on
/// Next click — never from a mount effect. React 19 StrictMode double-fires
/// mount effects in dev, and since `createJournal` is async, both
/// invocations would read `journals.length === 0` before either resolved,
/// creating two journals. A click is a single user action and avoids that.
export const JournalStep = forwardRef<JournalStepHandle, JournalStepProps>(function JournalStep(
  { onReadyChange },
  ref,
) {
  const { t } = useTranslation('auth')
  const { journals, isLoading, createJournal, updateJournal } = useJournals()
  const [firstJournalColor] = useState(getRandomJournalColor)
  const [name, setName] = useState(() => journals[0]?.name ?? t('onboarding.journal.name_default'))
  const [color, setColor] = useState(() => {
    const existingJournal = journals[0]
    return resolveOnboardingJournalColor(
      existingJournal?.is_initial_placeholder ?? false,
      existingJournal?.color,
      firstJournalColor,
    )
  })
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Keep the name and color edit gates independent so a name change while
  // journals are loading cannot replace an existing journal's color.
  const [nameEdited, setNameEdited] = useState(false)
  const [colorEdited, setColorEdited] = useState(false)

  // Prefill from the existing journal on the resume path. `useJournals` fetches
  // asynchronously, so at mount `journals` is empty and the lazy initialisers
  // above fall back to defaults; this effect syncs the real name/color once the
  // fetch resolves. Without it, a resumed wizard shows "My Journal" and a blind
  // Next would rename the user's journal back to the default. Skipped once the
  // user edits anything, so it never overwrites live input. On the fresh path
  // (zero journals) `journals[0]` stays undefined and the defaults hold.
  const existing = journals[0]
  useEffect(() => {
    if (!existing) return
    if (!nameEdited) setName(existing.name)
    if (!colorEdited) {
      setColor(
        resolveOnboardingJournalColor(
          existing.is_initial_placeholder,
          existing.color,
          firstJournalColor,
        ),
      )
    }
  }, [colorEdited, existing, firstJournalColor, nameEdited])

  const handleNameChange = (value: string) => {
    setNameEdited(true)
    setName(value)
  }
  const handleColorChange = (hex: string) => {
    setColorEdited(true)
    setColor(hex)
  }

  const trimmedName = name.trim()
  // Also gate on `isLoading`: useJournals fetches on mount, and reading
  // `journals.length === 0` before that fetch resolves would misclassify a
  // resumed wizard (existing journal not loaded yet) as "first pass" and
  // create a second journal instead of renaming the first.
  const ready = trimmedName.length > 0 && !isLoading && !committing

  useEffect(() => {
    onReadyChange(ready)
  }, [ready, onReadyChange])

  useImperativeHandle(
    ref,
    () => ({
      commit: async () => {
        const finalName = name.trim()
        if (!finalName) return false
        setError(null)
        setCommitting(true)
        try {
          if (journals.length === 0) {
            await createJournal(finalName, color)
          } else {
            await updateJournal(journals[0].id, finalName, color)
          }
          return true
        } catch {
          setError(t('onboarding.journal.save_error'))
          return false
        } finally {
          setCommitting(false)
        }
      },
    }),
    [name, color, journals, createJournal, updateJournal, t],
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label
          htmlFor="onboarding-journal-name"
          className="text-fg mb-1.5 block text-sm font-medium"
        >
          {t('onboarding.journal.name_label')}
        </label>
        <TextInput
          id="onboarding-journal-name"
          value={name}
          onChange={handleNameChange}
          autoFocus
        />
        {error && (
          <p role="alert" className="text-danger-text mt-1.5 text-xs">
            {error}
          </p>
        )}
      </div>

      <div>
        <span className="text-fg mb-1.5 block text-sm font-medium">
          {t('onboarding.journal.color_label')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('onboarding.journal.color_label')}
          className="flex flex-wrap gap-2"
        >
          {PRESET_COLORS.map((c) => (
            <button
              key={c.hex}
              type="button"
              role="radio"
              aria-checked={color === c.hex}
              aria-label={c.name}
              tabIndex={color === c.hex ? 0 : -1}
              onClick={() => handleColorChange(c.hex)}
              style={{ backgroundColor: c.hex }}
              className={cn(
                'size-8 rounded-full transition-[filter] duration-200 hover:brightness-110',
                'motion-reduce:transition-none',
                'outline-none',
                color === c.hex && 'ring-focus-ring shadow-sm ring-2 ring-offset-2',
              )}
            />
          ))}
        </div>
      </div>
    </div>
  )
})

JournalStep.displayName = 'JournalStep'
