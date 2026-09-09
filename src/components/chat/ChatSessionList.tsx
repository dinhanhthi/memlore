import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, MessageSquare, MessagesSquare, Pin, Check, X, Search, Sparkle } from 'lucide-react'
import type { ChatSessionMeta } from '../../types/ai'
import type { DailyChatReady } from '../../hooks/useAiDailyChatReady'
import { isDailyChatActionEnabled } from '../../hooks/useAiDailyChatReady'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Paginator } from '../common/Paginator'
import { TextInput } from '../common/TextInput'
import { Tooltip } from '../common/Tooltip'
import { formatFriendlyRelativeTime } from '../../lib/dates'
import { cn } from '../../lib/cn'
import ChatSessionListSkeleton from './ChatSessionListSkeleton'
import { ChatSessionMenu } from './ChatSessionMenu'
import { SecondPanel } from '../layout/SecondPanel'

interface ChatSessionListProps {
  sessions: ChatSessionMeta[]
  loading: boolean
  currentSessionId: string | null
  onSelect: (sessionId: string) => void
  onCreateNew: () => Promise<void> | void
  onDelete: (sessionId: string) => Promise<void> | void
  onRename: (sessionId: string, title: string) => Promise<void> | void
  onSetPinned: (sessionId: string, pinned: boolean) => Promise<void> | void
  /** True when the current selection is an unpersisted draft (a new chat with
   *  no message yet). Such an id is intentionally absent from the list, so the
   *  "on another page" banner must be suppressed for it. */
  isDraftSelected?: boolean
  /** Session id whose title was just updated by the backend; the
   *  matching row gets a brief highlight flash. */
  recentlyUpdatedTitleId?: string | null
  /** Pagination — current 1-based page. */
  page: number
  /** Pagination — total number of pages. */
  totalPages: number
  /** Pagination — callback to change the page. */
  onPageChange: (page: number) => void
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  /** AI readiness on this device (`null` while probing). Gates New + banner. */
  ready?: DailyChatReady | null
  /** Open Settings → AI (Providers) from the unconfigured banner CTA. */
  onOpenAiSettings?: () => void
}

export function ChatSessionList({
  sessions,
  loading,
  currentSessionId,
  onSelect,
  onCreateNew,
  onDelete,
  onRename,
  onSetPinned,
  isDraftSelected = false,
  recentlyUpdatedTitleId,
  page,
  totalPages,
  onPageChange,
  searchQuery,
  onSearchQueryChange,
  ready = null,
  onOpenAiSettings,
}: ChatSessionListProps) {
  const { t, i18n } = useTranslation('ai')
  const { panelAfterMain } = useLayoutFlags()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // One menu for the whole list — only one row can be open at a time, and
  // opening a second row's menu implicitly closes the first. `position` is set
  // for right-click (cursor-anchored); omitted when opened from the "…" button.
  const [openMenu, setOpenMenu] = useState<{
    id: string
    position?: { x: number; y: number }
  } | null>(null)
  const openMenuId = openMenu?.id ?? null
  const hasSearchQuery = searchQuery.trim().length > 0
  const canCreate = isDailyChatActionEnabled(ready)
  const showGateBanner = ready === 'needs_provider' || ready === 'needs_privacy'
  // Title-only warning (no long body) — CTA carries the next step.
  const gateTitleKey =
    ready === 'needs_privacy' ? 'daily_chat.gate_privacy' : 'daily_chat.gate_no_provider'

  function startRename(s: ChatSessionMeta) {
    setEditingId(s.id)
    setEditValue(s.title ?? '')
  }

  async function commitRename() {
    if (!editingId) return
    const trimmed = editValue.trim()
    if (trimmed) {
      await onRename(editingId, trimmed)
    }
    setEditingId(null)
    setEditValue('')
  }

  function cancelRename() {
    setEditingId(null)
    setEditValue('')
  }

  return (
    <SecondPanel standalone={false} frameClassName="w-75 shrink-0" role="complementary">
      <div className="border-border-default flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3.5">
        <h1 className="font-title text-fg text-xl font-extrabold tracking-[-.4px]">
          {t('daily_chat.sessions_title', { defaultValue: 'Conversations' })}
        </h1>
        <Button
          size="sm"
          icon={<Plus className="size-3.5" strokeWidth={1.75} />}
          onClick={() => void onCreateNew()}
          disabled={!canCreate}
          aria-label={t('daily_chat.new_chat', { defaultValue: 'New chat' })}
        >
          {t('daily_chat.new_chat_short', { defaultValue: 'New' })}
        </Button>
      </div>

      {/* Search field — a regular boxed TextInput (Clay paints it as a well)
          with equal padding on every side. */}
      <div className="border-border-default shrink-0 border-b p-2">
        <div className="relative">
          <Search
            className="text-fg-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            strokeWidth={1.75}
            aria-hidden
          />
          <TextInput
            type="search"
            value={searchQuery}
            onChange={onSearchQueryChange}
            placeholder={t('daily_chat.search_placeholder', {
              defaultValue: 'Search conversations…',
            })}
            aria-label={t('daily_chat.search_aria', {
              defaultValue: 'Search conversations',
            })}
            className="h-9 py-2 pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
          />
          {hasSearchQuery && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X className="size-3.5" aria-hidden />}
              onClick={() => onSearchQueryChange('')}
              aria-label={t('daily_chat.clear_search', {
                defaultValue: 'Clear conversation search',
              })}
              className="absolute top-1/2 right-1 size-7! -translate-y-1/2"
            />
          )}
        </div>
      </div>

      {/* AI not usable on this device — compact title + CTA only. */}
      {showGateBanner && (
        <div className="bg-elevated">
          <Callout
            tone="warning"
            flush
            className="border-border-default shrink-0 border-b"
            title={t(gateTitleKey)}
            action={
              onOpenAiSettings ? (
                <Button
                  variant="outline-secondary"
                  size="xs"
                  className="w-fit"
                  onClick={onOpenAiSettings}
                >
                  {t('daily_chat.gate_open_settings')}
                </Button>
              ) : undefined
            }
          />
        </div>
      )}

      {/* Banner: selected session is on a different page (never for a draft,
          whose id is deliberately not in the list until the first message). */}
      {currentSessionId !== null &&
        !isDraftSelected &&
        !loading &&
        !sessions.some((s) => s.id === currentSessionId) && (
          <div className="border-border-default text-warning shrink-0 border-b px-4 py-2 text-xs">
            {hasSearchQuery
              ? t('daily_chat.selected_outside_search', {
                  defaultValue: 'Selected conversation is outside these search results.',
                })
              : t('daily_chat.selected_on_other_page', {
                  defaultValue: 'Selected conversation is on another page.',
                })}
          </div>
        )}

      {/* Rows own their padding so the separators span the full pane width
          (same flat-list recipe as the Entries list). */}
      <RestoredScroll
        view="chat"
        sub="sessions"
        ready={!loading}
        className="flex-1 overflow-y-auto"
      >
        {loading && <ChatSessionListSkeleton />}
        {!loading && sessions.length === 0 && (
          <div className="text-fg-secondary px-4 py-6 text-center text-xs">
            {hasSearchQuery
              ? t('daily_chat.no_search_results', {
                  defaultValue: 'No conversations match your search.',
                })
              : t('daily_chat.empty_sessions', {
                  defaultValue: 'No conversations yet. Click "New chat".',
                })}
          </div>
        )}
        <ul className="flex flex-col">
          {sessions.map((s) => {
            const isSelected = s.id === currentSessionId
            const isEditing = editingId === s.id
            const isFlashing = recentlyUpdatedTitleId === s.id
            const titleText = s.title ?? t('daily_chat.untitled', { defaultValue: 'New chat' })
            const titleIsPlaceholder = s.title == null
            const messageCountLabel = t('daily_chat.message_count', {
              count: s.messageCount,
              defaultValue: '{{count}} messages',
            })

            return (
              <li key={s.id} className="border-border-default border-b last:border-b-0">
                <div
                  className={cn(
                    'xj-chat-row group relative w-full cursor-pointer px-4 py-3 text-left',
                    'transition-[background-color,box-shadow] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
                    panelAfterMain ? 'border-r-2' : 'border-l-2',
                    isSelected
                      ? panelAfterMain
                        ? 'border-r-accent bg-elevated'
                        : 'border-l-accent bg-elevated'
                      : panelAfterMain
                        ? 'hover:bg-elevated dark:hover:bg-surface-hi border-r-transparent'
                        : 'hover:bg-elevated dark:hover:bg-surface-hi border-l-transparent',
                    isFlashing && 'bg-accent-soft/40',
                  )}
                  onClick={() => {
                    if (!isEditing) onSelect(s.id)
                  }}
                  onContextMenu={(e) => {
                    // Same action menu as the "…" button, at the cursor — matches
                    // EntryCard / tab right-click. Skip while renaming so the
                    // native input menu still works for cut/copy/paste.
                    if (isEditing) return
                    e.preventDefault()
                    e.stopPropagation()
                    setOpenMenu({ id: s.id, position: { x: e.clientX, y: e.clientY } })
                  }}
                  role="button"
                  tabIndex={isEditing ? -1 : 0}
                  onKeyDown={(e) => {
                    if (isEditing) return
                    // Only act on keys aimed at the row itself. Without this,
                    // Enter/Space on a focused descendant — the dots trigger,
                    // or a menu item (portalled, but React synthetic events
                    // still bubble the React tree) — reaches here first, and
                    // the preventDefault below cancels the button's native
                    // activation. The menu would never open and the row would
                    // silently re-select instead: every action behind that
                    // trigger becomes mouse-only (WCAG 2.1.1).
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(s.id)
                    }
                  }}
                >
                  {isEditing ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') cancelRename()
                        }}
                        autoFocus
                        maxLength={80}
                        className="border-border-default bg-elevated text-fg flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void commitRename()
                        }}
                        className="text-fg-secondary hover:text-fg p-1"
                        aria-label={t('action.save', { defaultValue: 'Save' })}
                      >
                        <Check className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          cancelRename()
                        }}
                        className="text-fg-secondary hover:text-fg p-1"
                        aria-label={t('action.forget_cancel', { defaultValue: 'Cancel' })}
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Top row: icon + title. A pinned row swaps the generic
                          conversation glyph for a pin — the only always-visible
                          signal that the row is pinned, since the Pin/Unpin
                          wording lives inside the menu. It carries a real label
                          rather than aria-hidden: unlike the decorative
                          MessageSquare it replaces, it conveys state. */}
                      <div className="mb-1 flex items-start gap-2">
                        {s.pinnedAt != null ? (
                          <Pin
                            className="text-accent mt-0.5 size-3.5 shrink-0"
                            role="img"
                            aria-label={t('daily_chat.pinned', { defaultValue: 'Pinned' })}
                          />
                        ) : (
                          <MessageSquare
                            className="text-fg-secondary mt-0.5 size-3.5 shrink-0"
                            aria-hidden
                          />
                        )}
                        <div
                          className={cn(
                            'font-display line-clamp-2 flex-1 text-sm leading-tight font-medium tracking-[-0.2px]',
                            titleIsPlaceholder ? 'text-fg-muted italic' : 'text-fg',
                          )}
                        >
                          {titleText}
                        </div>
                      </div>

                      {/* Footer: relative time · message count · saved-as-entry */}
                      <div className="text-fg-muted mt-1.5 flex flex-wrap items-center gap-2 pl-5.5 text-xs font-medium">
                        <span>{formatFriendlyRelativeTime(s.createdAt, i18n.language)}</span>
                        <span aria-hidden>·</span>
                        <span
                          className="inline-flex items-center gap-1"
                          aria-label={messageCountLabel}
                        >
                          <MessagesSquare className="size-3" strokeWidth={1.75} aria-hidden />
                          <span aria-hidden>{s.messageCount}</span>
                        </span>
                        {s.convertedEntryId != null && (
                          <>
                            <span aria-hidden>·</span>
                            <Tooltip
                              content={t('daily_chat.saved_as_entry_indicator', {
                                defaultValue: 'Saved as entry',
                              })}
                            >
                              <Sparkle
                                className="text-accent size-3"
                                strokeWidth={1.75}
                                role="img"
                                aria-label={t('daily_chat.saved_as_entry_indicator', {
                                  defaultValue: 'Saved as entry',
                                })}
                              />
                            </Tooltip>
                          </>
                        )}
                      </div>

                      {/* Hover actions: the dots menu (rename · pin · remove) */}
                      {/* `focus-within` matters as much as `hover`: opacity-0
                          leaves the trigger in the tab order, so without it you
                          could tab to an invisible menu button (WCAG 2.4.7). */}
                      <div
                        className={cn(
                          'absolute top-2 right-2 transition-opacity',
                          // The menu is portalled to document.body, so neither
                          // group-hover nor group-focus-within holds once it is
                          // open — without a force-visible branch the trigger
                          // vanishes underneath its own popover. Right-click
                          // opens stay cursor-anchored: keep "…" hidden even if
                          // the pointer is still over the row.
                          openMenuId === s.id && openMenu?.position != null
                            ? 'pointer-events-none opacity-0'
                            : openMenuId === s.id
                              ? 'pointer-events-auto opacity-100'
                              : [
                                  'pointer-events-none opacity-0',
                                  'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                                  'group-hover:pointer-events-auto group-hover:opacity-100',
                                ],
                        )}
                      >
                        <ChatSessionMenu
                          session={s}
                          open={openMenuId === s.id}
                          position={openMenuId === s.id ? (openMenu?.position ?? null) : null}
                          onOpenChange={(next) => {
                            // Button path has no cursor anchor — drop `position`
                            // so the panel re-anchors to the "…" trigger.
                            setOpenMenu(next ? { id: s.id } : null)
                          }}
                          onRename={(sess) => {
                            // Clear the open id in the PARENT, not just via the
                            // child's post-handler close: `startRename` flips
                            // `editingId`, which unmounts ChatSessionMenu (the
                            // whole hover block lives inside the
                            // `editingId !== s.id` branch), so relying on the
                            // child to close itself races its own unmount. A
                            // stale `openMenuId` would make the menu spring open
                            // again the next time that row is hovered.
                            setOpenMenu(null)
                            startRename(sess)
                          }}
                          onDelete={(sess) => setConfirmDeleteId(sess.id)}
                          onSetPinned={(sess, pinned) => {
                            void onSetPinned(sess.id, pinned)
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </RestoredScroll>

      <Paginator
        currentPage={page}
        totalPages={totalPages}
        onPageChange={onPageChange}
        itemLabel="conversations"
        className="bg-panel-2"
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t('daily_chat.delete_confirm_title', { defaultValue: 'Delete this chat?' })}
        description={t('daily_chat.delete_confirm_body', {
          defaultValue: 'This conversation will be permanently removed.',
        })}
        confirmLabel={t('action.delete', { defaultValue: 'Delete' })}
        onConfirm={async () => {
          if (confirmDeleteId) await onDelete(confirmDeleteId)
        }}
        onClose={() => setConfirmDeleteId(null)}
      />
    </SecondPanel>
  )
}
