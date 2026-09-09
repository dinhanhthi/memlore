import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '../common/SegmentedControl'

export type Period = '7d' | '30d' | '90d' | '365d' | 'all'

interface PeriodOption {
  key: Period
  labelKey: string
}

const PERIODS: PeriodOption[] = [
  { key: '7d', labelKey: 'period.7d' },
  { key: '30d', labelKey: 'period.30d' },
  { key: '90d', labelKey: 'period.90d' },
  { key: '365d', labelKey: 'period.365d' },
  { key: 'all', labelKey: 'period.all' },
]

interface PeriodSelectorProps {
  value: Period
  onChange: (period: Period) => void
}

/**
 * Segmented control for selecting a time period in the Statistics view.
 * Renders 5 options: 7d / 30d / 90d / 365d / all.
 * Labels come from the `stats` i18n namespace.
 */
export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  const { t } = useTranslation('stats')

  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      ariaLabel={t('period.label')}
      options={PERIODS.map(({ key, labelKey }) => ({ value: key, label: t(labelKey) }))}
    />
  )
}
