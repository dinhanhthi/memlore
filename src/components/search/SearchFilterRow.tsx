import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { ChevronDown, Hash, Image as ImageIcon, NotebookPen, Smile } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { useJournals } from '../../hooks/useJournals'
import { useTags } from '../../hooks/useTags'
import { isHex6 } from '../../lib/tagColors'
import { EMOTIONS } from '../common/emotions'
import { PillButton } from '../common/PillButton'
import { RangePill } from '../common/RangePill'
import type { EmotionKey } from '../../types/entry'
import type { HasMediaState, SearchUiFilters } from './searchUiFilters'

interface SearchFilterRowProps {
  filters: SearchUiFilters
  onChange: (next: SearchUiFilters) => void
}

export function SearchFilterRow({ filters, onChange }: SearchFilterRowProps) {
  const { t: tNav } = useTranslation('nav')

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RangePill
        range={filters.range}
        onChange={(range) => onChange({ ...filters, range })}
        t={tNav}
      />
      <JournalPill
        selected={filters.journalIds}
        onChange={(journalIds) => onChange({ ...filters, journalIds })}
      />
      <TagsPill selected={filters.tagIds} onChange={(tagIds) => onChange({ ...filters, tagIds })} />
      <EmotionPill
        selected={filters.emotions}
        onChange={(emotions) => onChange({ ...filters, emotions })}
      />
      <HasMediaPill
        value={filters.hasMedia}
        onChange={(hasMedia) => onChange({ ...filters, hasMedia })}
      />
    </div>
  )
}

// ─── Shared multi-select primitive ─────────────────────────────────────────

interface MultiSelectItem {
  id: string
  label: string
  /** Optional left-side adornment — color swatch, emoji, etc. */
  adornment?: React.ReactNode
}

interface MultiSelectPillProps {
  icon: React.ReactNode
  /** Final pill label — caller resolves count formatting via i18n. */
  label: string
  /** Still needed to mark the pill as selected when count > 0. */
  selected: string[]
  items: MultiSelectItem[]
  onToggle: (id: string) => void
  /** Shown when items array is empty. */
  emptyMessage?: string
  /** Floating popover width. Defaults to 220. */
  menuWidth?: number
}

function MultiSelectPill({
  icon,
  label,
  selected,
  items,
  onToggle,
  emptyMessage,
  menuWidth = 220,
}: MultiSelectPillProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'listbox' })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
  ])

  const count = selected.length

  return (
    <>
      <PillButton
        ref={refs.setReference}
        selected={count > 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        {...getReferenceProps()}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown className="size-3" strokeWidth={1.75} />
      </PillButton>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, width: menuWidth }}
            id={menuId}
            aria-multiselectable="true"
            {...getFloatingProps()}
            className={cn(
              'bg-elevated rounded-xl shadow-xl',
              'border-border-default z-50 max-h-70 overflow-y-auto border',
            )}
          >
            {items.length === 0 ? (
              emptyMessage ? (
                <div className="text-fg-muted px-3 py-2 text-sm">{emptyMessage}</div>
              ) : null
            ) : (
              items.map((it) => {
                const isSelected = selected.includes(it.id)
                return (
                  <button
                    key={it.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    {...getItemProps({
                      onClick: () => onToggle(it.id),
                    })}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm',
                      'hover:bg-panel-2 transition-colors',
                      isSelected && 'bg-accent-soft text-accent-text',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="text-fg-muted flex w-3 shrink-0 justify-center"
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                    {it.adornment && (
                      <span aria-hidden="true" className="inline-flex shrink-0 items-center">
                        {it.adornment}
                      </span>
                    )}
                    <span className="flex-1 truncate">{it.label}</span>
                  </button>
                )
              })
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

// ─── Toggle helper ──────────────────────────────────────────────────────────

function toggleId(arr: string[], id: string): string[] {
  return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]
}

// ─── Journal pill ───────────────────────────────────────────────────────────

function JournalPill({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const { t } = useTranslation('ai')
  const { journals } = useJournals()

  const items: MultiSelectItem[] = journals
    .filter((j) => !j.is_deleted)
    .map((j) => ({
      id: j.id,
      label: j.name,
      adornment: (
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: j.color ?? 'var(--color-accent)' }}
        />
      ),
    }))

  const count = selected.length
  const label =
    count > 0 ? t('search.filter.journal_pill_count', { count }) : t('search.filter.journal_pill')

  return (
    <MultiSelectPill
      icon={<NotebookPen className="size-3" strokeWidth={1.75} />}
      label={label}
      selected={selected}
      items={items}
      onToggle={(id) => onChange(toggleId(selected, id))}
      emptyMessage={t('search.filter.journal_empty')}
    />
  )
}

// ─── Tags pill ───────────────────────────────────────────────────────────────

function TagsPill({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const { t } = useTranslation('ai')
  const { tags } = useTags()

  const items: MultiSelectItem[] = tags.map((tag) => {
    const dotColor = isHex6(tag.color) ? tag.color : 'var(--color-accent)'
    return {
      id: tag.id,
      label: tag.name,
      adornment: <span className="size-2 rounded-full" style={{ backgroundColor: dotColor }} />,
    }
  })

  const count = selected.length
  const label =
    count > 0 ? t('search.filter.tags_pill_count', { count }) : t('search.filter.tags_pill')

  return (
    <MultiSelectPill
      icon={<Hash className="size-3" strokeWidth={1.75} />}
      label={label}
      selected={selected}
      items={items}
      onToggle={(id) => onChange(toggleId(selected, id))}
      emptyMessage={t('search.filter.tags_empty')}
    />
  )
}

// ─── Emotion pill ────────────────────────────────────────────────────────────

function EmotionPill({
  selected,
  onChange,
}: {
  selected: EmotionKey[]
  onChange: (next: EmotionKey[]) => void
}) {
  const { t: tAi } = useTranslation('ai')
  const { t: tEditor } = useTranslation('editor')

  const items: MultiSelectItem[] = EMOTIONS.map((e) => ({
    id: e.key,
    label: tEditor(e.i18nKey),
    adornment: <span className="text-base leading-none">{e.emoji}</span>,
  }))

  const count = selected.length
  const label =
    count > 0
      ? tAi('search.filter.emotion_pill_count', { count })
      : tAi('search.filter.emotion_pill')

  return (
    <MultiSelectPill
      icon={<Smile className="size-3" strokeWidth={1.75} />}
      label={label}
      selected={selected as string[]}
      items={items}
      onToggle={(id) => {
        // id is guaranteed to be a valid EmotionKey since items are seeded from EMOTIONS
        const emotionKey = id as EmotionKey
        const next = selected.includes(emotionKey)
          ? selected.filter((k) => k !== emotionKey)
          : [...selected, emotionKey]
        onChange(next)
      }}
    />
  )
}

// ─── Has media pill (tri-state, no popover) ──────────────────────────────────

function HasMediaPill({
  value,
  onChange,
}: {
  value: HasMediaState
  onChange: (next: HasMediaState) => void
}) {
  const { t } = useTranslation('ai')

  const next: Record<HasMediaState, HasMediaState> = { any: 'has', has: 'none', none: 'any' }

  const label: Record<HasMediaState, string> = {
    any: t('search.filter.has_media_any'),
    has: t('search.filter.has_media_has'),
    none: t('search.filter.has_media_none'),
  }

  return (
    <PillButton
      selected={value !== 'any'}
      onClick={() => onChange(next[value])}
      aria-label={label[value]}
    >
      <ImageIcon className="size-3" strokeWidth={1.75} />
      <span>{label[value]}</span>
    </PillButton>
  )
}
