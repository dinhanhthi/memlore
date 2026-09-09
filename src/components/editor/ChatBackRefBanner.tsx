import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'

export interface ChatBackRefBannerProps {
  sessionId: string
  /** Title of the source chat session, surfaced as a tooltip on the label.
   *  `null` when the session has no title yet — the tooltip is suppressed. */
  title: string | null
  onOpen: (sessionId: string) => void
}

/**
 * Compact banner above the entry editor title when the open entry was
 * generated from a Daily Chat conversation. Subtle strip with session label
 * and a secondary "Open conversation" button that hands off to Daily Chat.
 *
 * Filled with `bg-surface-subtle` rather than `bg-accent-soft`: with a custom
 * accent the soft token resolves to `accent / 0.14`, a translucent wash that
 * barely lifts off the editor's `bg-elevated` panel. Accent identity lives in
 * the border + icon only. Not a warning — the orphaned-media banner below it
 * owns the warning styling.
 */
export function ChatBackRefBanner({ sessionId, title, onOpen }: ChatBackRefBannerProps) {
  const { t } = useTranslation('editor')
  const label = t('editor:chat_backref.label')
  return (
    <div className="border-accent/25 bg-selected-tab mb-3 flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
      <Tooltip content={title ?? ''} disabled={!title} placement="bottom">
        <div className="text-fg-secondary flex min-w-0 items-center gap-1.5 text-xs">
          <MessageSquare className="text-accent size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </div>
      </Tooltip>
      <Button variant="secondary" size="xs" className="shrink-0" onClick={() => onOpen(sessionId)}>
        {t('editor:chat_backref.open')}
      </Button>
    </div>
  )
}
