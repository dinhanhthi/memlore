import { useTranslation } from 'react-i18next'
import { RadioOptionPill } from '../common/RadioOptionPill'
import type { EmotionSuggestionLanguage } from '../../types/ai'

interface EmotionSuggestionLanguagePickerProps {
  language: EmotionSuggestionLanguage
  onChange: (language: EmotionSuggestionLanguage) => void
  disabled?: boolean
}

interface LanguageOption {
  id: EmotionSuggestionLanguage
  labelKey: string
  defaultLabel: string
}

const OPTIONS: LanguageOption[] = [
  { id: 'auto', labelKey: 'emotion_suggestions.language.auto', defaultLabel: 'Auto' },
  { id: 'en', labelKey: 'emotion_suggestions.language.en', defaultLabel: 'English' },
  { id: 'vi', labelKey: 'emotion_suggestions.language.vi', defaultLabel: 'Tiếng Việt' },
  { id: 'fr', labelKey: 'emotion_suggestions.language.fr', defaultLabel: 'Français' },
  { id: 'es', labelKey: 'emotion_suggestions.language.es', defaultLabel: 'Español' },
  {
    id: 'zh-Hans',
    labelKey: 'emotion_suggestions.language.zh-Hans',
    defaultLabel: '简体中文',
  },
  {
    id: 'zh-Hant',
    labelKey: 'emotion_suggestions.language.zh-Hant',
    defaultLabel: '繁體中文',
  },
]

export function EmotionSuggestionLanguagePicker({
  language,
  onChange,
  disabled,
}: EmotionSuggestionLanguagePickerProps) {
  const { t } = useTranslation('ai')

  return (
    <div className="space-y-2">
      <div className="text-fg text-sm font-medium">
        {t('emotion_suggestions.language.label', { defaultValue: 'Language' })}
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup">
        {OPTIONS.map((opt) => (
          <RadioOptionPill
            key={opt.id}
            selected={language === opt.id}
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className="px-3 py-1 text-sm"
            label={t(opt.labelKey, { defaultValue: opt.defaultLabel })}
          />
        ))}
      </div>
    </div>
  )
}
