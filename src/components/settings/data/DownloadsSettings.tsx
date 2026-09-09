import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDownloadedAssets, type DownloadedAsset } from '../../../hooks/useDownloadedAssets'
import { formatBytes } from '../../../lib/numbers'
import { Button } from '../../common/Button'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { SettingsRow } from '../SettingsRow'
import { SettingsGroup } from '../SettingsSurfaceCard'
import { SettingsSection } from '../SettingsSection'

const ROW = 'px-4'

function rowTitle(row: DownloadedAsset, t: (key: string) => string): string {
  if (row.kind === 'basemap') return t('data_section.downloads.offline_map')
  if (row.kind === 'fonts') return t('data_section.downloads.custom_fonts')
  return row.title
}

function DownloadRow({ row, onRemove }: { row: DownloadedAsset; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <SettingsRow
      className={ROW}
      divider={false}
      title={rowTitle(row, t)}
      hint={formatBytes(row.sizeBytes)}
      titleBadge={
        row.inUse ? (
          <span className="text-fg-muted text-xs">{t('data_section.downloads.in_use')}</span>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="xs" onClick={row.openSetting}>
          {t('data_section.downloads.open_in_settings')}
        </Button>
        <Button variant="destructive" size="xs" onClick={onRemove}>
          {t('data_section.downloads.remove')}
        </Button>
      </div>
    </SettingsRow>
  )
}

export function DownloadsSettings() {
  const { t } = useTranslation('settings')
  const { assets } = useDownloadedAssets()
  const [pending, setPending] = useState<DownloadedAsset | null>(null)

  const maps = assets.filter((a) => a.kind === 'basemap')
  const ai = assets.filter(
    (a) => a.kind === 'embed_model' || a.kind === 'llm_model' || a.kind === 'llm_binary',
  )
  const editor = assets.filter((a) => a.kind === 'fonts')

  return (
    <div>
      <SettingsSection hint={t('data_section.downloads.hint')}>
        {assets.length === 0 ? (
          <p className="text-fg-muted text-sm">{t('data_section.downloads.empty')}</p>
        ) : (
          <div className="space-y-5">
            {maps.length > 0 && (
              <SettingsGroup title={t('data_section.downloads.groups.maps')}>
                {maps.map((row) => (
                  <DownloadRow
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    onRemove={() => setPending(row)}
                  />
                ))}
              </SettingsGroup>
            )}
            {ai.length > 0 && (
              <SettingsGroup title={t('data_section.downloads.groups.ai')}>
                {ai.map((row) => (
                  <DownloadRow
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    onRemove={() => setPending(row)}
                  />
                ))}
              </SettingsGroup>
            )}
            {editor.length > 0 && (
              <SettingsGroup title={t('data_section.downloads.groups.editor')}>
                {editor.map((row) => (
                  <DownloadRow
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    onRemove={() => setPending(row)}
                  />
                ))}
              </SettingsGroup>
            )}
          </div>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.inUse
            ? t('data_section.downloads.remove_in_use_title')
            : t('data_section.downloads.remove')
        }
        description={
          pending?.inUse
            ? t('data_section.downloads.remove_in_use_body', {
                impact: t(pending.impactKey),
              })
            : t('data_section.downloads.remove_idle')
        }
        confirmLabel={t('data_section.downloads.remove')}
        onConfirm={() => pending?.remove()}
        onClose={() => setPending(null)}
      />
    </div>
  )
}
