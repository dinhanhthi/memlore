import { BookOpenText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEntryTitles } from '../../hooks/useEntryTitles'
import { truncateText } from '../../lib/truncateText'
import { Tooltip } from '../common/Tooltip'

const BADGE_TITLE_MAX = 32

export interface EntryRefBadgeProps {
  entryId: string
  onOpen: (entryId: string) => void
}

/**
 * Inline badge standing in for an `[id=…]` marker the model echoed out of
 * its journal context block. Shows the entry's title only — the raw id is a
 * UUID that means nothing to the reader and made replies look broken.
 *
 * Renders as a resolving placeholder first, then the title. An entry that
 * cannot be resolved (deleted, locked, or locked *after* the reply was
 * generated) stays non-interactive rather than opening a modal that can only
 * say "unavailable".
 */
export function EntryRefBadge({ entryId, onOpen }: EntryRefBadgeProps) {
  const { t } = useTranslation(['ai', 'editor'])
  const { titles, loading } = useEntryTitles([entryId])

  // `useEntryTitles` omits ids it could not resolve, so a missing key after
  // loading finished means unavailable — distinct from "still fetching".
  const resolved = titles.get(entryId)
  const isResolving = loading && resolved === undefined

  if (isResolving) {
    return (
      <span className="border-border-default bg-panel-2 text-fg-muted text-2xs mx-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 align-baseline">
        <BookOpenText className="size-3 shrink-0" aria-hidden />
        {t('daily_chat.entry_badge_resolving', { defaultValue: 'Entry…' })}
      </span>
    )
  }

  if (resolved === undefined) {
    return (
      <span className="border-border-default bg-panel-2 text-fg-muted text-2xs mx-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 align-baseline">
        <BookOpenText className="size-3 shrink-0" aria-hidden />
        {t('daily_chat.entry_badge_unavailable', { defaultValue: 'Entry unavailable' })}
      </span>
    )
  }

  const fullTitle = resolved ?? t('editor:untitled_entry', { defaultValue: 'Untitled' })
  const label = truncateText(fullTitle, BADGE_TITLE_MAX)

  return (
    <Tooltip content={fullTitle} placement="top" disabled={label === fullTitle}>
      <button
        type="button"
        onClick={() => onOpen(entryId)}
        aria-label={t('daily_chat.entry_badge_open', {
          title: fullTitle,
          defaultValue: 'Open "{{title}}"',
        })}
        className="border-border-default bg-panel-2 text-fg-secondary text-2xs hover:border-accent/50 hover:bg-accent-soft hover:text-accent-text mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 align-baseline font-medium transition-colors outline-none"
      >
        <BookOpenText className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
    </Tooltip>
  )
}
