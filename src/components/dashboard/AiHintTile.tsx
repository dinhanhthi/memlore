import { useTranslation } from 'react-i18next'
import { navigateToSetting } from '../../lib/settingsNavigation'
import { DashboardCard } from './DashboardCard'
import { DashboardNavButton } from './DashboardNavButton'

export function AiHintTile({ title, feature }: { title: string; feature: string }) {
  const { t } = useTranslation('dashboard')
  return (
    <DashboardCard
      title={title}
      action={
        <DashboardNavButton
          label={t('insights.enable_link')}
          onClick={() => navigateToSetting('ai', { aiTab: 'features' })}
        />
      }
    >
      <p className="text-fg-muted line-clamp-2 text-xs">{t('ai_hint.body', { feature })}</p>
    </DashboardCard>
  )
}
