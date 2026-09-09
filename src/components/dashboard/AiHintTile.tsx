import { useTranslation } from 'react-i18next'
import { navigateToSetting } from '../../lib/settingsNavigation'
import { Button } from '../common/Button'
import { DashboardCard } from './DashboardCard'

export function AiHintTile({ title, feature }: { title: string; feature: string }) {
  const { t } = useTranslation('dashboard')
  return (
    <DashboardCard
      title={title}
      action={
        <Button
          variant="ghost"
          size="xs"
          onClick={() => navigateToSetting('ai', { aiTab: 'features' })}
        >
          {t('insights.enable_link')}
        </Button>
      }
    >
      <p className="text-fg-muted line-clamp-2 text-xs">{t('ai_hint.body', { feature })}</p>
    </DashboardCard>
  )
}
