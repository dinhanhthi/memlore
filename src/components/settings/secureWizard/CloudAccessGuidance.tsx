import { useTranslation } from 'react-i18next'
import { cloudGuidanceVariant } from '../../../lib/cloudGuidanceVariant'
import { useSyncStore } from '../../../stores/syncStore'

const GOOGLE_STEP_KEYS = [
  'security.revoke.cloud_guidance_google_step1',
  'security.revoke.cloud_guidance_google_step2',
  'security.revoke.cloud_guidance_google_step3',
  'security.revoke.cloud_guidance_google_step4',
] as const

const ICLOUD_STEP_KEYS = [
  'security.revoke.cloud_guidance_icloud_step1',
  'security.revoke.cloud_guidance_icloud_step2',
] as const

interface CloudAccessGuidanceProps {
  provider?: string | null
}

export function CloudAccessGuidance({ provider: providerOverride }: CloudAccessGuidanceProps = {}) {
  const { t } = useTranslation('settings')
  const currentProvider = useSyncStore((state) => state.status?.provider ?? null)
  const provider = providerOverride === undefined ? currentProvider : providerOverride
  const variant = cloudGuidanceVariant(provider)

  if (variant === 'generic') {
    return (
      <div className="border-border-default rounded-2xl border p-4">
        <p className="text-fg-muted text-sm leading-relaxed">
          {t('security.revoke.cloud_guidance_generic')}
        </p>
      </div>
    )
  }

  const isGoogle = variant === 'google'
  const titleKey = isGoogle
    ? 'security.revoke.cloud_guidance_google_title'
    : 'security.revoke.cloud_guidance_icloud_title'
  const stepKeys = isGoogle ? GOOGLE_STEP_KEYS : ICLOUD_STEP_KEYS

  return (
    <div className="border-border-default flex flex-col gap-2 rounded-2xl border p-4">
      <p className="text-fg text-sm font-semibold">{t(titleKey)}</p>
      <ol className="text-fg-muted flex list-decimal flex-col gap-1.5 ps-5 text-sm leading-relaxed">
        {stepKeys.map((key) => (
          <li key={key} className="ps-1">
            {t(key)}
          </li>
        ))}
      </ol>
    </div>
  )
}
