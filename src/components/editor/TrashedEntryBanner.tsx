import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { Button } from '../common/Button'
import { useTrash } from '../../hooks/useTrash'

/** Strip above a trashed entry opened from a stale tab or persisted selection.
 * Mounted only for a trashed entry so `useTrash` fetches the Trash list only
 * then. Restoring emits `entries-changed`; EditorPanel refetches the entry and
 * the editor becomes editable again. */
export function TrashedEntryBanner({ entryId }: { entryId: string }) {
  const { t } = useTranslation('editor')
  const { restore } = useTrash()
  const [isBusy, setIsBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const handleRestore = async () => {
    if (isBusy) return
    setIsBusy(true)
    setFailed(false)
    try {
      await restore(entryId)
    } catch (err: unknown) {
      console.error('[TrashedEntryBanner] restore failed:', err)
      setFailed(true)
    }
    setIsBusy(false)
  }

  return (
    <div
      role="status"
      className="bg-panel-2 text-fg-secondary border-border-subtle flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm"
    >
      <span className="flex-1">
        {t('panel.trashed_banner')}
        {failed && (
          <span className="text-danger-text ml-2">{t('panel.trashed_restore_failed')}</span>
        )}
      </span>
      <Button
        variant="secondary"
        size="xs"
        icon={<RotateCcw className="size-3.5" aria-hidden />}
        loading={isBusy}
        onClick={() => void handleRestore()}
      >
        {t('panel.trashed_restore')}
      </Button>
    </div>
  )
}
