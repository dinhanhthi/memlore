import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, type SelectOption } from '../common/Select'
import { TextInput } from '../common/TextInput'
import type { DailyChatPersona } from '../../types/ai'

const PRESET_LIMIT_CUSTOM_CHARS = 1000

interface DailyChatPersonaPickerProps {
  persona: DailyChatPersona
  customPersona: string
  onChangePersona: (persona: DailyChatPersona) => void
  onChangeCustom: (text: string) => void
  disabled?: boolean
}

interface PersonaOption {
  id: DailyChatPersona
  labelKey: string
  defaultLabel: string
  hintKey: string
  defaultHint: string
}

const OPTIONS: PersonaOption[] = [
  {
    id: 'empathetic',
    labelKey: 'daily_chat.persona.empathetic',
    defaultLabel: 'Empathetic Friend',
    hintKey: 'daily_chat.persona.empathetic_hint',
    defaultHint: 'Warm, listens for feelings',
  },
  {
    id: 'tough',
    labelKey: 'daily_chat.persona.tough',
    defaultLabel: 'Tough Coach',
    hintKey: 'daily_chat.persona.tough_hint',
    defaultHint: 'Direct, accountability-driven',
  },
  {
    id: 'jolly',
    labelKey: 'daily_chat.persona.jolly',
    defaultLabel: 'Jolly Friend',
    hintKey: 'daily_chat.persona.jolly_hint',
    defaultHint: 'Playful, finds the bright side',
  },
  {
    id: 'wise',
    labelKey: 'daily_chat.persona.wise',
    defaultLabel: 'Wise Mentor',
    hintKey: 'daily_chat.persona.wise_hint',
    defaultHint: 'Philosophical, listens deeply',
  },
  {
    id: 'custom',
    labelKey: 'daily_chat.persona.custom',
    defaultLabel: 'Custom',
    hintKey: 'daily_chat.persona.custom_hint',
    defaultHint: 'Write your own prompt',
  },
  {
    id: 'cbt_reframe',
    labelKey: 'reflection_lens.cbt_reframe',
    defaultLabel: 'CBT reframe',
    hintKey: 'reflection_lens.cbt_reframe_hint',
    defaultHint: 'Gentle cognitive reframing',
  },
  {
    id: 'gratitude',
    labelKey: 'reflection_lens.gratitude',
    defaultLabel: 'Gratitude',
    hintKey: 'reflection_lens.gratitude_hint',
    defaultHint: 'Notice what went well',
  },
  {
    id: 'inversion',
    labelKey: 'reflection_lens.inversion',
    defaultLabel: 'Inversion',
    hintKey: 'reflection_lens.inversion_hint',
    defaultHint: 'Challenge assumptions',
  },
  {
    id: 'stoic',
    labelKey: 'reflection_lens.stoic',
    defaultLabel: 'Stoic',
    hintKey: 'reflection_lens.stoic_hint',
    defaultHint: 'Control, virtue, acceptance',
  },
]

export function DailyChatPersonaPicker({
  persona,
  customPersona,
  onChangePersona,
  onChangeCustom,
  disabled,
}: DailyChatPersonaPickerProps) {
  const { t } = useTranslation('ai')
  const customCharCount = customPersona.length

  // Each persona's one-liner rides along as the option `description`, so the
  // dropdown itself explains the choices — no separate caption needed.
  const options: SelectOption[] = useMemo(
    () =>
      OPTIONS.map((opt) => ({
        value: opt.id,
        label: t(opt.labelKey, { defaultValue: opt.defaultLabel }),
        description: t(opt.hintKey, { defaultValue: opt.defaultHint }),
      })),
    [t],
  )

  const label = t('daily_chat.persona.label', { defaultValue: 'AI Friend persona' })

  return (
    <div className="space-y-2">
      {/* Label + compact select on one row (matches other settings toggles). */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-fg min-w-0 text-sm font-medium">{label}</span>
        <Select
          value={persona}
          onChange={(next) => onChangePersona(next as DailyChatPersona)}
          options={options}
          disabled={disabled}
          aria-label={label}
          className="h-8 w-full max-w-62.5 shrink-0 basis-62.5 px-3 py-1.5"
        />
      </div>

      {persona === 'custom' && (
        <div className="space-y-1">
          <TextInput
            multiline
            value={customPersona}
            onChange={(next) => onChangeCustom(next.slice(0, PRESET_LIMIT_CUSTOM_CHARS))}
            disabled={disabled}
            rows={4}
            placeholder={t('daily_chat.persona.custom_placeholder', {
              defaultValue:
                'Describe how the AI should sound. e.g. "You are a no-nonsense fitness coach who…"',
            })}
            className="resize-y"
          />
          <div className="text-fg-secondary text-2xs flex items-center justify-end">
            {customCharCount} / {PRESET_LIMIT_CUSTOM_CHARS}
          </div>
        </div>
      )}
    </div>
  )
}
