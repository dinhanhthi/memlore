import { useTranslation } from 'react-i18next'
import { useLanguage } from '../../../hooks/useLanguage'
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../../lib/languages'
import { RadioOptionPillGroup } from '../../common/RadioOptionPill'

// Bilingual labels — this is the FIRST onboarding step, so the user hasn't
// chosen a language yet. Each option shows both the English name and the
// native name (where they differ) so it's recognisable regardless of which
// language the app currently renders in. These are language names, not
// translatable copy, so they're fixed rather than pulled from i18n.
const LANGUAGE_LABEL: Record<SupportedLanguage, string> = {
  en: 'English',
  vi: 'Vietnamese / Tiếng Việt',
}

/// `LanguageStep` — picks the UI language, shown first so every later step
/// renders in the chosen language. `setLanguage` is localStorage-only (no DB
/// write) and switches the whole app's language immediately.
export function LanguageStep() {
  const { t } = useTranslation(['auth', 'settings'])
  const { uiLanguage, setLanguage } = useLanguage()

  return (
    <RadioOptionPillGroup<SupportedLanguage>
      ariaLabel={t('settings:language.title')}
      value={uiLanguage}
      onChange={(next) => void setLanguage(next)}
      className="justify-center"
      options={SUPPORTED_LANGUAGES.map((lang) => ({
        value: lang,
        label: LANGUAGE_LABEL[lang],
      }))}
    />
  )
}
