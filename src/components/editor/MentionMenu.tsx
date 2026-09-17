import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { formatCompactDate } from '../../lib/dates'
import type { MentionCandidate } from '../../lib/mentionSearch'

interface MentionMenuProps {
  items: MentionCandidate[]
  activeIndex: number
  /** Viewport-clamped height from the popup placement so last rows stay reachable. */
  maxHeight?: number
  isLoading: boolean
  onSelect: (index: number) => void
}

const containerBase =
  'border-border-default bg-elevated max-h-70 w-70 overflow-y-auto rounded-xl border p-1.5 shadow-xl'
const rowBase =
  'flex flex-col gap-0.5 px-2.5 py-2 rounded-lg cursor-pointer border-none bg-transparent w-full text-left'

export function MentionMenu({
  items,
  activeIndex,
  maxHeight,
  isLoading,
  onSelect,
}: MentionMenuProps) {
  const { t } = useTranslation('editor')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = listRef.current?.querySelector('[role="option"][aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Keep the previous list visible while a newer query is in flight; only the
  // very first keystrokes (no results yet) render nothing so the popup never
  // flashes an empty box.
  if (items.length === 0 && isLoading) return null

  const style = maxHeight != null ? { maxHeight } : undefined

  if (items.length === 0) {
    return (
      <div
        className={containerBase}
        style={style}
        role="listbox"
        aria-label={t('mention.listbox_label')}
      >
        <div role="presentation" className="text-fg-muted px-2.5 py-2 text-xs">
          {t('mention.empty')}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className={containerBase}
      style={style}
      role="listbox"
      aria-label={t('mention.listbox_label')}
    >
      {items.map((item, i) => {
        const active = i === activeIndex
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={active}
            className={cn(rowBase, active ? 'gradient-accent-soft text-accent-text' : 'text-fg')}
            onMouseDown={(e) => {
              // Prevent the editor selection from collapsing before the
              // mention is inserted.
              e.preventDefault()
              onSelect(i)
            }}
          >
            <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
            <span className="text-fg-muted min-w-0 truncate text-xs">
              {formatCompactDate(item.entryDate)}
              {item.preview ? ` · ${item.preview}` : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
