import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag as TagIcon, X } from 'lucide-react'
import {
  useFloating,
  useHover,
  useFocus,
  useDismiss,
  useClick,
  useInteractions,
  safePolygon,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
} from '@floating-ui/react'
import { addTagToEntry, getTagsForEntry, removeTagFromEntry } from '../../lib/tauri'
import { useTags, emitTagsChanged } from '../../hooks/useTags'
import { useSuggestTags } from '../../hooks/useSuggestTags'
import { useAiTagSuggestionsEnabled } from '../../hooks/useAiTagSuggestionsEnabled'
import { canCreateTagName, filterTagSuggestions } from '../../lib/tagPicker'
import { randomTagColor } from '../../lib/tagColors'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import type { Tag } from '../../types/journal'
import { AiIcon } from '../common/AiIcon'
import { Button } from '../common/Button'

interface EntryTagsPillProps {
  entryId: string | null
}

const HEX6 = /^#[0-9A-Fa-f]{6}$/

function dotColor(tag: Tag): string {
  return tag.color && HEX6.test(tag.color) ? tag.color : 'var(--color-accent)'
}

/// Editor-footer pill that lists this entry's tags and exposes a popover to
/// add (existing or new) and remove tags.
///
/// Concurrency note: every mutation snapshots `entryId` at call time
/// (via `entryIdRef`) so a slow IPC racing with an entry switch never
/// applies its optimistic-state rollback to the wrong entry's chip list.
/// Only `memlore:tags-changed` is emitted — the join-table change does
/// not modify any row in `entries`, so `entries-changed` would be
/// over-broadcast.
export function EntryTagsPill({ entryId }: EntryTagsPillProps) {
  const { t } = useTranslation('editor')
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const { tags: allTags, createTag, refresh: refreshTags } = useTags()
  const tagSuggestionsEnabled = useAiTagSuggestionsEnabled()
  const {
    state: suggestState,
    suggest,
    dismiss: dismissSuggestions,
    removeSuggestion,
  } = useSuggestTags()

  const [entryTags, setEntryTags] = useState<Tag[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss])

  // Separate floating stack for AI suggest-results — do not share refs/context
  // with the Add-tag picker above.
  const suggestOpen = suggestState.kind === 'done' && suggestState.entryId === entryId
  const {
    refs: suggestRefs,
    floatingStyles: suggestFloatingStyles,
    context: suggestContext,
  } = useFloating({
    open: suggestOpen,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) dismissSuggestions()
    },
    placement: 'top-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  })
  const suggestDismiss = useDismiss(suggestContext)
  const { getReferenceProps: getSuggestReferenceProps, getFloatingProps: getSuggestFloatingProps } =
    useInteractions([suggestDismiss])

  // Mirrors `entryId` for use inside async closures — lets a post-await
  // handler check whether the entry it was started on is still the
  // active entry before mutating state.
  const entryIdRef = useRef<string | null>(entryId)

  // Load tags for this entry whenever entry changes
  useEffect(() => {
    entryIdRef.current = entryId
    dismissSuggestions()
    if (!entryId) {
      setEntryTags([])
      return
    }
    let cancelled = false
    void getTagsForEntry(entryId, activeVaultId).then((tags) => {
      if (!cancelled) setEntryTags(tags)
    })
    return () => {
      cancelled = true
    }
  }, [entryId, activeVaultId, dismissSuggestions])

  useEffect(() => {
    if (open) {
      void refreshTags()
      inputRef.current?.focus({ preventScroll: true })
    } else {
      setQuery('')
    }
  }, [open, refreshTags])

  const entryTagIds = useMemo(() => entryTags.map((t) => t.id), [entryTags])

  const suggestions = useMemo(
    () => filterTagSuggestions(allTags, { query, excludeIds: entryTagIds }),
    [allTags, entryTagIds, query],
  )

  const trimmedQuery = query.trim()
  const canCreate = canCreateTagName(allTags, query)

  async function handleAddExisting(tag: Tag) {
    if (!entryId) return
    const targetEntry = entryId
    setEntryTags((prev) => [...prev, tag])
    setQuery('')
    try {
      await addTagToEntry(targetEntry, tag.id)
      emitTagsChanged()
    } catch (err) {
      if (entryIdRef.current === targetEntry) {
        setEntryTags((prev) => prev.filter((x) => x.id !== tag.id))
      }
      console.error('Failed to add tag to entry:', err)
    }
  }

  async function handleAddSuggested(name: string) {
    if (!entryId) return
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (!entryTagIds.includes(existing.id)) {
        await handleAddExisting(existing)
      }
      removeSuggestion(name)
      return
    }
    const targetEntry = entryId
    let created: Tag
    try {
      created = await createTag(name, randomTagColor())
    } catch (err) {
      console.error('Failed to create suggested tag:', err)
      return
    }
    if (entryIdRef.current !== targetEntry) return
    setEntryTags((prev) => [...prev, created])
    try {
      await addTagToEntry(targetEntry, created.id)
      emitTagsChanged()
      removeSuggestion(name)
    } catch (err) {
      if (entryIdRef.current === targetEntry) {
        setEntryTags((prev) => prev.filter((x) => x.id !== created.id))
      }
      console.error('Failed to attach suggested tag:', err)
    }
  }

  async function handleCreateAndAdd() {
    if (!entryId || !trimmedQuery) return
    const targetEntry = entryId
    let created: Tag
    try {
      created = await createTag(trimmedQuery, randomTagColor())
    } catch (err) {
      console.error('Failed to create tag:', err)
      return
    }
    if (entryIdRef.current !== targetEntry) return
    setEntryTags((prev) => [...prev, created])
    setQuery('')
    try {
      await addTagToEntry(targetEntry, created.id)
      emitTagsChanged()
    } catch (err) {
      if (entryIdRef.current === targetEntry) {
        setEntryTags((prev) => prev.filter((x) => x.id !== created.id))
      }
      console.error('Failed to attach created tag to entry:', err)
    }
  }

  async function handleRemove(tag: Tag) {
    if (!entryId) return
    const targetEntry = entryId
    setEntryTags((prev) => prev.filter((x) => x.id !== tag.id))
    try {
      await removeTagFromEntry(targetEntry, tag.id)
      emitTagsChanged()
    } catch (err) {
      if (entryIdRef.current === targetEntry) {
        setEntryTags((prev) => [...prev, tag])
      }
      console.error('Failed to remove tag from entry:', err)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0) void handleAddExisting(suggestions[0])
      else if (canCreate) void handleCreateAndAdd()
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && query === '' && entryTags.length > 0) {
      void handleRemove(entryTags[entryTags.length - 1])
    }
  }

  if (!entryId) return null

  return (
    <div className="inline-flex items-center gap-1.5">
      {entryTags.length > 0 && (
        <CollapsedTagsPill tags={entryTags} onRemove={(tag) => void handleRemove(tag)} />
      )}

      <Button
        ref={refs.setReference}
        variant="outline"
        size="xs"
        active={open}
        aria-label={t('pills.tag_add')}
        aria-expanded={open}
        aria-haspopup="dialog"
        {...getReferenceProps()}
      >
        {t('pills.tag_add')}
      </Button>

      {tagSuggestionsEnabled === true && (
        <>
          <Button
            ref={suggestRefs.setReference}
            variant="outline"
            size="xs"
            icon={<AiIcon aria-hidden />}
            loading={suggestState.kind === 'loading'}
            active={suggestOpen}
            aria-expanded={suggestOpen}
            aria-haspopup="dialog"
            {...getSuggestReferenceProps({
              onClick: () => {
                if (entryId) void suggest(entryId)
              },
            })}
          >
            {t('tags_popover.suggest', { defaultValue: 'Suggest tag' })}
          </Button>

          {suggestOpen && suggestState.kind === 'done' && (
            <FloatingPortal>
              <div
                ref={suggestRefs.setFloating}
                role="dialog"
                aria-label={t('tags_popover.suggest_dialog_aria')}
                style={suggestFloatingStyles}
                className="border-border-default bg-elevated z-40 w-56 rounded-xl border p-2 shadow-lg"
                {...getSuggestFloatingProps()}
              >
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <span className="text-fg text-2xs font-mono font-medium">
                    {t('tags_popover.suggest_title')}
                  </span>
                  <button
                    type="button"
                    aria-label={t('tags_popover.suggest_close')}
                    onClick={() => dismissSuggestions()}
                    className="text-fg-muted hover:text-fg flex size-5 items-center justify-center rounded-full outline-none"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {suggestState.suggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => void handleAddSuggested(name)}
                      // Neutral chip. The popover sits on `bg-elevated`, so a
                      // plain `border-default` hairline would vanish. Accent is
                      // reserved for the hover edge — the label stays neutral
                      // so a list of suggestions doesn't read as a wall of
                      // accent text.
                      className="border-border-default bg-surface-subtle text-fg-secondary hover:text-fg hover:border-accent/50 text-2xs rounded-full border px-2 py-0.5 font-mono transition-colors"
                    >
                      + {name}
                    </button>
                  ))}
                </div>
              </div>
            </FloatingPortal>
          )}
        </>
      )}

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-label={t('tags_popover.dialog_aria')}
            style={floatingStyles}
            className="border-border-default bg-elevated z-40 w-70 rounded-xl border p-2 shadow-lg"
            {...getFloatingProps()}
          >
            <div className="border-border-default mb-2 flex items-center gap-2 rounded-lg border px-2 py-1.5">
              <TagIcon className="text-fg-muted size-3.5 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label={t('tags_popover.search_aria')}
                placeholder={t('tags_popover.search_placeholder')}
                className="xj-input-bare text-fg placeholder:text-fg-muted flex-1 border-0 bg-transparent text-xs outline-none"
              />
            </div>

            <ul role="listbox" className="max-h-55 overflow-y-auto">
              {suggestions.length === 0 && !canCreate && (
                <li className="text-fg-muted text-2xs px-2 py-1.5">
                  {trimmedQuery === ''
                    ? allTags.length === 0
                      ? t('tags_popover.empty')
                      : t('tags_popover.all_added')
                    : t('tags_popover.no_matches')}
                </li>
              )}

              {suggestions.map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => void handleAddExisting(tag)}
                    className="text-fg hover:bg-surface-subtle flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.75 w-1.75 shrink-0 rounded-full"
                      style={{ backgroundColor: dotColor(tag) }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </button>
                </li>
              ))}

              {canCreate && (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => void handleCreateAndAdd()}
                    className="text-accent hover:bg-accent-soft flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none"
                  >
                    <span aria-hidden="true">+</span>
                    <span className="truncate">
                      {t('tags_popover.create', { name: trimmedQuery })}
                    </span>
                  </button>
                </li>
              )}
            </ul>
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}

interface CollapsedTagsPillProps {
  tags: Tag[]
  onRemove: (tag: Tag) => void
}

/// Footer-friendly summary pill: shows "N tags" and reveals the full chip
/// list on hover/focus via a floating popover. Keeps the footer on one line
/// regardless of tag count.
function CollapsedTagsPill({ tags, onRemove }: CollapsedTagsPillProps) {
  const { t } = useTranslation('editor')
  const [open, setOpen] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 6 })],
  })

  const hover = useHover(context, {
    delay: { open: 80, close: 0 },
    handleClose: safePolygon(),
  })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss])

  return (
    <>
      <Button
        ref={refs.setReference}
        variant="outline"
        size="xs"
        icon={<TagIcon aria-hidden="true" className="size-3 shrink-0" />}
        active={open}
        aria-expanded={open}
        aria-haspopup="dialog"
        {...getReferenceProps()}
      >
        {t('pills.tag_count', { count: tags.length })}
      </Button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-label={t('pills.tag_list_aria')}
            style={floatingStyles}
            className="border-border-default bg-elevated z-40 max-w-80 rounded-xl border p-2 shadow-lg"
            {...getFloatingProps()}
          >
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag.id}
                  className="border-border-default text-fg-secondary text-2xs inline-flex items-center gap-1 rounded-full border px-2 py-1 font-mono font-medium"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: dotColor(tag) }}
                  />
                  <span>{tag.name}</span>
                  <button
                    type="button"
                    aria-label={t('pills.tag_remove', { name: tag.name })}
                    onClick={() => onRemove(tag)}
                    className="text-fg-muted hover:text-fg ml-0.5 flex items-center justify-center rounded-full outline-none"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
