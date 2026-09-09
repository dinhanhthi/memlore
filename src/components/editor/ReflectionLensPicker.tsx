import { useTranslation } from 'react-i18next'
import { Brain, Heart, Lightbulb, RotateCcw, Sparkles } from 'lucide-react'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { Tooltip } from '../common/Tooltip'
import type { ReflectionLens } from '../../types/ai'

const LENS_OPTIONS: {
  id: ReflectionLens
  labelKey: string
  defaultLabel: string
  /** One-liner shown on hover — same keys the Daily Chat persona picker
   *  renders as its option descriptions, so both surfaces stay in sync. */
  hintKey: string
  defaultHint: string
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}[] = [
  {
    id: 'default',
    labelKey: 'reflection_lens.default',
    defaultLabel: 'Default',
    hintKey: 'reflection_lens.default_hint',
    defaultHint: 'Open-ended reflection',
    Icon: Sparkles,
  },
  {
    id: 'cbt_reframe',
    labelKey: 'reflection_lens.cbt_reframe',
    defaultLabel: 'CBT reframe',
    hintKey: 'reflection_lens.cbt_reframe_hint',
    defaultHint: 'Gentle cognitive reframing',
    Icon: Brain,
  },
  {
    id: 'gratitude',
    labelKey: 'reflection_lens.gratitude',
    defaultLabel: 'Gratitude',
    hintKey: 'reflection_lens.gratitude_hint',
    defaultHint: 'Notice what went well',
    Icon: Heart,
  },
  {
    id: 'inversion',
    labelKey: 'reflection_lens.inversion',
    defaultLabel: 'Inversion',
    hintKey: 'reflection_lens.inversion_hint',
    defaultHint: 'Challenge assumptions',
    Icon: RotateCcw,
  },
  {
    id: 'stoic',
    labelKey: 'reflection_lens.stoic',
    defaultLabel: 'Stoic',
    hintKey: 'reflection_lens.stoic_hint',
    defaultHint: 'Control, virtue, acceptance',
    Icon: Lightbulb,
  },
]

interface ReflectionLensPickerProps {
  lens: ReflectionLens
  onChange: (lens: ReflectionLens) => void
  disabled?: boolean
  compact?: boolean
}

export function ReflectionLensPicker({
  lens,
  onChange,
  disabled,
  compact,
}: ReflectionLensPickerProps) {
  const { t } = useTranslation('ai')

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      {!compact && (
        <div className="text-fg text-sm font-medium">
          {t('reflection_lens.label', { defaultValue: 'Reflection lens' })}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5" role="radiogroup">
        {LENS_OPTIONS.map((opt) => {
          const Icon = opt.Icon
          const label = t(opt.labelKey, { defaultValue: opt.defaultLabel })
          const hint = t(opt.hintKey, { defaultValue: opt.defaultHint })
          return (
            <Tooltip key={opt.id} content={hint} placement="bottom">
              <RadioOptionPill
                selected={lens === opt.id}
                disabled={disabled}
                onClick={() => onChange(opt.id)}
                className="gap-1.5 px-2.5 py-1 text-xs"
                // Tooltip's `aria-describedby` lands on its wrapper span, not
                // on the focusable radio, so the hint would be mouse-only.
                // Fold it into the accessible name instead — the visible
                // label stays the prefix, satisfying WCAG "Label in Name".
                aria-label={`${label} — ${hint}`}
                label={
                  <>
                    <Icon className="size-3.5" aria-hidden />
                    <span>{label}</span>
                  </>
                }
              />
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
