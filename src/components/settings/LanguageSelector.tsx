import { useTranslation } from 'react-i18next'
import { useLanguage } from '../../hooks/useLanguage'
import type { SupportedLanguage } from '../../lib/i18n'
import { SegmentedControl } from '../common/SegmentedControl'
import { SettingsRow } from './SettingsRow'

interface Option {
  id: SupportedLanguage
  labelKey: string
}

const OPTIONS: Option[] = [
  { id: 'en', labelKey: 'language.english' },
  { id: 'vi', labelKey: 'language.vietnamese' },
]

interface LanguageSelectorProps {
  /** Extra classes on the underlying `SettingsRow` (e.g. `px-4` inside a card). */
  className?: string
  /** Draw the row's bottom hairline. Default `true`; set `false` when a parent
   *  card owns `divide-y` dividers. */
  divider?: boolean
}

/// `LanguageSelector` — capsule toggle of two localized language options.
/// Calls `useLanguage()` so switching is persisted to SQLite and pushed
/// through i18next in one step.
export function LanguageSelector({ className, divider = true }: LanguageSelectorProps) {
  const { t } = useTranslation('settings')
  const { uiLanguage, setLanguage } = useLanguage()

  return (
    <SettingsRow
      title={t('language.title')}
      hint={t('language.hint')}
      className={className}
      divider={divider}
    >
      <SegmentedControl<SupportedLanguage>
        ariaLabel={t('language.title')}
        value={uiLanguage}
        onChange={(id) => void setLanguage(id)}
        commitOnArrow={false}
        options={OPTIONS.map((opt) => ({
          value: opt.id,
          label: t(opt.labelKey),
          tooltip: t(opt.labelKey),
          ariaLabel: t(opt.labelKey),
        }))}
      />
    </SettingsRow>
  )
}
