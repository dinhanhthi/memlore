/* eslint-disable react-refresh/only-export-components */
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import type { Editor, Range } from '@tiptap/react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { i18n } from '../../lib/i18n'
import {
  formatSlashDate,
  formatSlashDateFull,
  formatSlashNow,
  formatSlashTime,
  shiftLocalDate,
} from '../../lib/slashDateTime'
import { filterSlashItems } from '../../lib/slashMenuQuery'
import {
  Heading1,
  Heading2,
  List,
  ListChecks,
  Quote,
  Code2,
  Image,
  Paperclip,
  Minus,
  Sigma,
  FunctionSquare,
  Calendar,
  CalendarDays,
  CalendarClock,
  Clock,
  type LucideIcon,
} from 'lucide-react'
import { Kbd } from '../common/primitives'

export type SlashMenuItemKey =
  | 'heading-1'
  | 'heading-2'
  | 'bullet-list'
  | 'checklist'
  | 'quote'
  | 'code-block'
  | 'image'
  | 'attach'
  | 'divider'
  | 'inline-math'
  | 'block-math'
  | 'today'
  | 'today-full'
  | 'yesterday'
  | 'yesterday-full'
  | 'tomorrow'
  | 'tomorrow-full'
  | 'time'
  | 'now'

export type SlashMenuGroup = 'block' | 'datetime'

export interface SlashMenuItem {
  key: SlashMenuItemKey
  label: string
  icon: LucideIcon
  hint?: string
  aliases?: string[]
  group?: SlashMenuGroup
  command: (ctx: { editor: Editor; range: Range }) => void
}

/** i18n key for a section heading when the group changes; null within a group. */
export function slashMenuSectionHeadingKey(
  items: Pick<SlashMenuItem, 'group'>[],
  index: number,
): 'slash.basic_blocks' | 'slash.date_time' | null {
  const current = items[index]
  if (!current) return null
  const group = current.group ?? 'block'
  const prev = index > 0 ? (items[index - 1]?.group ?? 'block') : undefined
  if (prev === group) return null
  return group === 'datetime' ? 'slash.date_time' : 'slash.basic_blocks'
}

function insertPlainText(ed: Editor, range: Range, text: string): void {
  ed.chain().focus().deleteRange(range).insertContent(text).run()
}

function insertFormattedDateTime(
  ed: Editor,
  range: Range,
  format: (now: Date, lang: string) => string,
): void {
  const now = new Date()
  insertPlainText(ed, range, format(now, i18n.language))
}

/** Suggestion `items()` entry point — key + alias + label, not label alone. */
export function getSlashMenuItemsForQuery(
  editor: Editor,
  query: string,
  options?: { mathEnabled?: boolean },
): SlashMenuItem[] {
  const t = i18n.getFixedT(null, 'editor')
  return filterSlashItems(buildSlashMenuItems(editor, t, options), query)
}

/**
 * Basic blocks first (Heading 1 stays first), then Date & time commands.
 * Order is load-bearing — arrow keys walk this list.
 *
 * `t` should be bound to the 'editor' namespace, e.g.
 * `i18n.getFixedT(null, 'editor')` or `useTranslation('editor').t`.
 */
export function buildSlashMenuItems(
  editor: Editor,
  t: TFunction,
  options?: { mathEnabled?: boolean },
): SlashMenuItem[] {
  // `editor` is captured by the closures so we can't reuse items across
  // editor instances, but the suggestion pipeline builds a fresh array each
  // pop-over open, so that's fine.
  void editor
  // StarterKit's augmentations for `setHeading` / `toggleBlockquote` load
  // through `@tiptap/extension-heading` + `@tiptap/extension-blockquote` via
  // StarterKit. Our editor has them, but the top-level `ChainedCommands`
  // type in `@tiptap/core` doesn't expose them without an explicit import of
  // those extensions. Rather than pull the extensions in twice, we narrow
  // through a structural cast.
  interface Chain {
    setHeading: (attrs: { level: number }) => Chain
    toggleBulletList: () => Chain
    toggleTaskList: () => Chain
    toggleBlockquote: () => Chain
    toggleCodeBlock: () => Chain
    setHorizontalRule: () => Chain
    deleteRange: (range: Range) => Chain
    focus: () => Chain
    run: () => boolean
  }
  const c = (ed: Editor) => ed.chain() as unknown as Chain
  return [
    {
      key: 'heading-1' as const,
      label: t('slash.heading_1'),
      icon: Heading1,
      hint: '#',
      command: ({ editor: ed, range }) =>
        c(ed).focus().deleteRange(range).setHeading({ level: 1 }).run(),
    },
    {
      key: 'heading-2' as const,
      label: t('slash.heading_2'),
      icon: Heading2,
      hint: '##',
      command: ({ editor: ed, range }) =>
        c(ed).focus().deleteRange(range).setHeading({ level: 2 }).run(),
    },
    {
      key: 'bullet-list' as const,
      label: t('slash.bullet_list'),
      icon: List,
      hint: '-',
      command: ({ editor: ed, range }) => c(ed).focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      key: 'checklist' as const,
      label: t('slash.checklist'),
      icon: ListChecks,
      hint: '[]',
      command: ({ editor: ed, range }) => c(ed).focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      key: 'quote' as const,
      label: t('slash.quote'),
      icon: Quote,
      hint: '>',
      command: ({ editor: ed, range }) => c(ed).focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      key: 'code-block' as const,
      label: t('slash.code_block'),
      icon: Code2,
      hint: '```',
      command: ({ editor: ed, range }) => c(ed).focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      key: 'image' as const,
      label: t('slash.image'),
      icon: Image,
      // Image insertion routes through the host's file picker — the extension
      // supplies the concrete handler via `onImage` in SlashMenu extension
      // wire-up. From the menu's perspective, it's just another command.
      command: ({ editor: ed, range }) => {
        ed.chain().focus().deleteRange(range).run()
        // Consumers (Editor.tsx) replace this command via overrideImageHandler
        // when they mount the extension. The default is a no-op.
      },
    },
    {
      key: 'attach' as const,
      label: t('slash.attach_image'),
      icon: Paperclip,
      command: ({ editor: ed, range }) => {
        ed.chain().focus().deleteRange(range).run()
        // Consumers (Editor.tsx) supply the concrete handler via onAttachImage.
        // The default is a no-op.
      },
    },
    {
      key: 'divider' as const,
      label: t('slash.divider'),
      icon: Minus,
      hint: '---',
      command: ({ editor: ed, range }) =>
        c(ed).focus().deleteRange(range).setHorizontalRule().run(),
    },
    ...(options?.mathEnabled
      ? ([
          {
            key: 'inline-math' as const,
            label: t('slash.inline_math'),
            icon: FunctionSquare,
            hint: '$',
            command: ({ editor: ed, range }) => {
              ed.chain().focus().deleteRange(range).run()
            },
          },
          {
            key: 'block-math' as const,
            label: t('slash.block_math'),
            icon: Sigma,
            hint: '$$',
            command: ({ editor: ed, range }) => {
              ed.chain().focus().deleteRange(range).run()
            },
          },
        ] satisfies SlashMenuItem[])
      : []),
    {
      key: 'today' as const,
      label: t('slash.today'),
      icon: Calendar,
      hint: '/today',
      aliases: ['date'],
      group: 'datetime',
      command: ({ editor: ed, range }) => insertFormattedDateTime(ed, range, formatSlashDate),
    },
    {
      key: 'today-full' as const,
      label: t('slash.today_full'),
      icon: CalendarDays,
      hint: '/today-full',
      group: 'datetime',
      command: ({ editor: ed, range }) => insertFormattedDateTime(ed, range, formatSlashDateFull),
    },
    {
      key: 'yesterday' as const,
      label: t('slash.yesterday'),
      icon: Calendar,
      hint: '/yesterday',
      group: 'datetime',
      command: ({ editor: ed, range }) =>
        insertFormattedDateTime(ed, range, (now, lang) =>
          formatSlashDate(shiftLocalDate(now, -1), lang),
        ),
    },
    {
      key: 'yesterday-full' as const,
      label: t('slash.yesterday_full'),
      icon: CalendarDays,
      hint: '/yesterday-full',
      group: 'datetime',
      command: ({ editor: ed, range }) =>
        insertFormattedDateTime(ed, range, (now, lang) =>
          formatSlashDateFull(shiftLocalDate(now, -1), lang),
        ),
    },
    {
      key: 'tomorrow' as const,
      label: t('slash.tomorrow'),
      icon: Calendar,
      hint: '/tomorrow',
      group: 'datetime',
      command: ({ editor: ed, range }) =>
        insertFormattedDateTime(ed, range, (now, lang) =>
          formatSlashDate(shiftLocalDate(now, 1), lang),
        ),
    },
    {
      key: 'tomorrow-full' as const,
      label: t('slash.tomorrow_full'),
      icon: CalendarDays,
      hint: '/tomorrow-full',
      group: 'datetime',
      command: ({ editor: ed, range }) =>
        insertFormattedDateTime(ed, range, (now, lang) =>
          formatSlashDateFull(shiftLocalDate(now, 1), lang),
        ),
    },
    {
      key: 'time' as const,
      label: t('slash.time'),
      icon: Clock,
      hint: '/time',
      group: 'datetime',
      command: ({ editor: ed, range }) =>
        insertFormattedDateTime(ed, range, (now) => formatSlashTime(now)),
    },
    {
      key: 'now' as const,
      label: t('slash.now'),
      icon: CalendarClock,
      hint: '/now',
      group: 'datetime',
      command: ({ editor: ed, range }) => insertFormattedDateTime(ed, range, formatSlashNow),
    },
  ]
}

interface SlashMenuProps {
  items: SlashMenuItem[]
  activeIndex: number
  onSelect: (index: number) => void
  /** Viewport-clamped height from `placeSlashMenu` so last rows stay reachable. */
  maxHeight?: number
}

const rowBase =
  'flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer border-none bg-transparent w-full text-left'
const iconBubbleBase =
  'size-6 rounded-md bg-border-subtle grid place-items-center text-fg-muted shrink-0'

export function SlashMenu({ items, activeIndex, onSelect, maxHeight }: SlashMenuProps) {
  const { t } = useTranslation('editor')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = listRef.current?.querySelector('[role="option"][aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      ref={listRef}
      className="border-border-default bg-elevated max-h-70 w-max min-w-70 overflow-y-auto rounded-xl border p-1.5 shadow-xl"
      style={maxHeight != null ? { maxHeight } : undefined}
      role="listbox"
      aria-label={t('slash.listbox_label')}
    >
      {items.map((item, i) => {
        const active = i === activeIndex
        const headingKey = slashMenuSectionHeadingKey(items, i)
        return (
          <Fragment key={item.key}>
            {headingKey ? (
              <div
                role="presentation"
                className="text-fg-muted text-2xs pt-1.5 pr-2.5 pb-1 pl-2.5 font-bold tracking-[0.6px] uppercase"
              >
                {t(headingKey)}
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={active}
              className={cn(rowBase, active ? 'gradient-accent-soft text-accent-text' : 'text-fg')}
              onMouseDown={(e) => {
                // Prevent the editor selection from collapsing before the
                // command runs. Index is against `items`, not a split group.
                e.preventDefault()
                onSelect(i)
              }}
            >
              <span className={iconBubbleBase}>
                <item.icon className="size-3" strokeWidth={1.75} />
              </span>
              <span className="flex-1 text-xs font-medium whitespace-nowrap">{item.label}</span>
              {item.hint ? (
                <span className="shrink-0">
                  <Kbd>{item.hint}</Kbd>
                </span>
              ) : (
                (null as ReactNode)
              )}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
