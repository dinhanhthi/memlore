import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '../common/SegmentedControl'
import { TextInput } from '../common/TextInput'
import type { ResponseLanguagePreset } from '../../types/ai'

type ResponseLanguageChoice = ResponseLanguagePreset | 'custom'

interface ResponseLanguagePickerProps {
  /** Raw stored value — `"auto"` | `"en"` | `"vi"` | a custom English
   *  language name (e.g. `"French"`). */
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}

const PRESETS: { id: ResponseLanguagePreset; labelKey: string; defaultLabel: string }[] = [
  { id: 'auto', labelKey: 'general.response_language.auto', defaultLabel: 'Auto' },
  { id: 'en', labelKey: 'general.response_language.en', defaultLabel: 'English' },
  { id: 'vi', labelKey: 'general.response_language.vi', defaultLabel: 'Tiếng Việt' },
]

const MAX_CUSTOM_CHARS = 64

function isPreset(value: string): value is ResponseLanguagePreset {
  return value === 'auto' || value === 'en' || value === 'vi'
}

export function ResponseLanguagePicker({ value, onChange, disabled }: ResponseLanguagePickerProps) {
  const { t } = useTranslation('ai')
  const [customMode, setCustomMode] = useState(!isPreset(value))
  const [draft, setDraft] = useState(isPreset(value) ? '' : value)

  // A custom value can arrive from outside (initial load, or another
  // device via sync) — adjust local state during render when `value`
  // changes, rather than in an effect (React's recommended pattern for
  // syncing state to a changed prop; avoids the extra render an effect
  // would cause). See https://react.dev/learn/you-might-not-need-an-effect.
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    if (!isPreset(value)) {
      setCustomMode(true)
      setDraft(value)
    }
  }

  const selected: ResponseLanguageChoice = customMode
    ? 'custom'
    : isPreset(value)
      ? value
      : 'custom'

  function commitCustom() {
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    if (trimmed !== value) onChange(trimmed)
  }

  function handleSelect(id: ResponseLanguageChoice) {
    if (id === 'custom') {
      setCustomMode(true)
      return
    }
    setCustomMode(false)
    onChange(id)
  }

  const customLabel = t('general.response_language.custom', { defaultValue: 'Custom' })
  const groupLabel = t('general.response_language.label', { defaultValue: 'AI response language' })

  return (
    <div className="space-y-2">
      <div className="text-fg text-sm font-medium">{groupLabel}</div>
      <div className="text-fg-secondary text-xs">
        {t('general.response_language.hint', {
          defaultValue:
            'Applies to every AI feature — title suggestions, highlights, Go Deeper, summaries, and more.',
        })}
      </div>
      <SegmentedControl<ResponseLanguageChoice>
        ariaLabel={groupLabel}
        value={selected}
        onChange={handleSelect}
        commitOnArrow={false}
        disabled={disabled}
        options={[
          ...PRESETS.map((opt) => ({
            value: opt.id,
            label: t(opt.labelKey, { defaultValue: opt.defaultLabel }),
            ariaLabel: t(opt.labelKey, { defaultValue: opt.defaultLabel }),
          })),
          {
            value: 'custom' as const,
            label: customLabel,
            ariaLabel: customLabel,
          },
        ]}
      />
      {selected === 'custom' && (
        <TextInput
          value={draft}
          onChange={(next) => setDraft(next.slice(0, MAX_CUSTOM_CHARS))}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitCustom()
            }
          }}
          disabled={disabled}
          maxLength={MAX_CUSTOM_CHARS}
          placeholder={t('general.response_language.custom_placeholder', {
            defaultValue: 'e.g. French, Japanese',
          })}
          aria-label={customLabel}
          className="max-w-64"
        />
      )}
    </div>
  )
}
