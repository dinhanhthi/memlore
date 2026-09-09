import { Cloud, HardDrive } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { isMacOS } from '../../lib/platform'
import { providerLabel, providerOrder } from '../../lib/providerLabel'
import type { CloudProviderKind } from '../../lib/tauri'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'

const PROVIDER_DESCRIPTION_KEYS = {
  gdrive: 'cloud.providers.gdrive.description',
  icloud: 'cloud.providers.icloud.description',
  local: 'cloud.providers.local.description',
} as const

function ProviderIcon({ kind }: { kind: CloudProviderKind }) {
  const Icon = kind === 'local' ? HardDrive : Cloud
  return <Icon className="size-5 shrink-0" aria-hidden />
}

export interface CloudProviderPickerProps {
  value: CloudProviderKind | null
  onChange: (kind: CloudProviderKind) => void
  localPath?: string | null
  onPickFolder: () => void
  icloudAvailable: boolean
  disabled?: boolean
}

export function CloudProviderPicker({
  value,
  onChange,
  localPath,
  onPickFolder,
  icloudAvailable,
  disabled = false,
}: CloudProviderPickerProps) {
  const { t } = useTranslation('settings')
  const entries = providerOrder(isMacOS(), icloudAvailable)

  return (
    <div
      role="group"
      aria-label={t('cloud.picker_title')}
      className={cn(
        'grid grid-cols-1 gap-3',
        entries.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
      )}
    >
      {entries.map(({ kind, disabled: kindDisabled }) => {
        const selected = value === kind
        const cardDisabled = disabled || kindDisabled
        const card = (
          <div
            className={cn(
              'bg-elevated flex h-full min-w-0 flex-col rounded-xl',
              'motion-safe:transition-[box-shadow,border-color,background-color] motion-safe:duration-150',
              'motion-reduce:transition-none',
              selected
                ? 'gradient-border-primary border border-transparent [--border-gradient-width:2px]'
                : 'border-border-default border',
              !cardDisabled && 'hover:bg-surface-row-hover',
            )}
          >
            <button
              type="button"
              disabled={cardDisabled}
              aria-pressed={selected}
              data-testid={`cloud-provider-${kind}`}
              onClick={() => onChange(kind)}
              className={cn(
                'flex h-auto min-h-0 w-full flex-1 flex-col items-start justify-start gap-2 rounded-xl bg-transparent p-4 text-left whitespace-normal',
                'focus-visible:ring-accent outline-none focus-visible:ring-2 focus-visible:ring-inset',
                cardDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
            >
              <ProviderIcon kind={kind} />
              <span className="text-fg text-sm font-semibold">{providerLabel(kind, t)}</span>
              <span className="text-fg-muted text-xs leading-snug">
                {t(PROVIDER_DESCRIPTION_KEYS[kind])}
              </span>
            </button>
            {kind === 'local' ? (
              <div className="flex flex-col gap-3 px-4 pb-4">
                {localPath ? (
                  <p className="text-fg-muted min-w-0 truncate text-xs">{localPath}</p>
                ) : null}
                <Button
                  size="xs"
                  disabled={disabled}
                  onClick={onPickFolder}
                  className="w-full whitespace-nowrap"
                >
                  {t('cloud.choose_folder')}
                </Button>
              </div>
            ) : null}
          </div>
        )

        if (kind === 'icloud' && kindDisabled) {
          return (
            <Tooltip
              key={kind}
              content={t('cloud.icloud_unavailable_hint')}
              multiline
              className="h-full w-full"
            >
              {card}
            </Tooltip>
          )
        }

        return (
          <div key={kind} className="min-w-0">
            {card}
          </div>
        )
      })}
    </div>
  )
}
