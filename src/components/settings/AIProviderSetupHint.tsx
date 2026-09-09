import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProviderPreset } from '../../types/ai'
import { cn } from '../../lib/cn'

interface AIProviderSetupHintProps {
  preset: ProviderPreset
  className?: string
}

/**
 * Per-preset setup blurb. Always visible when a hint exists, rendered as a
 * single unadorned paragraph with the docs link inline.
 *
 * This is the *only* explanation of the active provider: it merges what the
 * provider group means for the user (where the data goes, what it costs) with
 * the setup steps for that preset. Full install docs live behind the
 * "Read more" link. Typically passed as `Modal.Header`'s `description` so
 * it sits under the provider title above the header hairline.
 */
export function AIProviderSetupHint({ preset, className }: AIProviderSetupHintProps) {
  const { t } = useTranslation('ai')
  const hint = t(`provider_hint.${preset.id}`, { defaultValue: '' })
  if (!hint) return null

  return (
    <p className={cn('text-sm leading-relaxed', className)}>
      {hint}
      {preset.setupUrl && (
        <a
          href={preset.setupUrl}
          onClick={(e) => {
            e.preventDefault()
            void openUrl(preset.setupUrl)
          }}
          className="text-accent hover:text-accent-hover ml-1.5 inline-flex items-center gap-1 align-baseline"
        >
          {t('action.read_more')}
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </p>
  )
}
