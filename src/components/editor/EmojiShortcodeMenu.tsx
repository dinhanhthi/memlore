import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import type { EmojiShortcodeMatch } from '../../lib/emojiShortcodes'

interface EmojiShortcodeMenuProps {
  items: EmojiShortcodeMatch[]
  activeIndex: number
  onSelect: (index: number) => void
}

const rowBase =
  'flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer border-none bg-transparent w-full text-left'

export function EmojiShortcodeMenu({ items, activeIndex, onSelect }: EmojiShortcodeMenuProps) {
  const { t } = useTranslation('editor')

  if (items.length === 0) return null

  return (
    <div
      className="border-border-default bg-elevated max-h-70 w-70 overflow-y-auto rounded-xl border p-1.5 shadow-xl"
      role="listbox"
      aria-label={t('emoji_shortcode.listbox_label')}
    >
      {items.map((item, i) => {
        const active = i === activeIndex
        return (
          <button
            key={`${item.char}-${item.shortcode}`}
            type="button"
            role="option"
            aria-selected={active}
            className={cn(rowBase, active ? 'gradient-accent-soft text-accent-text' : 'text-fg')}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(i)
            }}
          >
            <span className="grid size-7 shrink-0 place-items-center text-lg leading-none">
              {item.char}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">:{item.shortcode}:</span>
              <span className="text-fg-muted block truncate text-xs">{item.keywords}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
