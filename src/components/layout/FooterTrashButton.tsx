import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { useTrash } from '../../hooks/useTrash'
import { useTabStore } from '../../stores/tabStore'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'

/** Footer shortcut to Settings → Data → Recently deleted, shown only while
 * the Trash holds something. Mount it only where Trash is supported. */
export function FooterTrashButton() {
  const { t } = useTranslation('nav')
  const { entries } = useTrash()
  if (entries.length === 0) return null

  const label = t('footer.trash_tooltip', { count: entries.length })
  return (
    <Tooltip content={label} placement="top">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={label}
        className="text-accent h-6 px-2"
        onClick={() =>
          useTabStore.getState().updateActiveTab({
            activeView: 'settings',
            selectedEntryId: null,
            settingsCategory: 'data',
            dataTab: 'trash',
          })
        }
      >
        <Trash2 className="size-3.5" aria-hidden />
        <span className="tabular-nums">{entries.length}</span>
      </Button>
    </Tooltip>
  )
}
