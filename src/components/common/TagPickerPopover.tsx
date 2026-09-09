import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag as TagIcon, X } from 'lucide-react'
import { addTagToEntry, getTagsForEntry, removeTagFromEntry } from '../../lib/tauri'
import { useTags, emitTagsChanged } from '../../hooks/useTags'
import { canCreateTagName, filterTagSuggestions } from '../../lib/tagPicker'
import { randomTagColor } from '../../lib/tagColors'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import type { Tag } from '../../types/journal'

interface TagPickerPopoverProps {
  entryId: string
  /** Closes the popover. Caller handles outside-click + Esc. */
  onClose: () => void
}

const HEX6 = /^#[0-9A-Fa-f]{6}$/

function dotColor(tag: Tag): string {
  return tag.color && HEX6.test(tag.color) ? tag.color : 'var(--color-accent)'
}

/**
 * Reusable tag picker popover panel — same UX as EntryTagsPill's popover
 * but as a standalone component you can drop next to any anchor. The
 * caller is responsible for positioning (e.g. floating-ui) and for
 * dismissing on outside click.
 */
export function TagPickerPopover({ entryId, onClose }: TagPickerPopoverProps) {
  const { t } = useTranslation('editor')
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const { tags: allTags, createTag, refresh: refreshTags } = useTags()

  const [entryTags, setEntryTags] = useState<Tag[]>([])
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const entryIdRef = useRef<string>(entryId)

  useEffect(() => {
    entryIdRef.current = entryId
    let cancelled = false
    void getTagsForEntry(entryId, activeVaultId).then((tags) => {
      if (!cancelled) setEntryTags(tags)
    })
    return () => {
      cancelled = true
    }
  }, [entryId, activeVaultId])

  useEffect(() => {
    void refreshTags()
    inputRef.current?.focus({ preventScroll: true })
  }, [refreshTags])

  const entryTagIds = useMemo(() => entryTags.map((tag) => tag.id), [entryTags])

  const suggestions = useMemo(
    () => filterTagSuggestions(allTags, { query, excludeIds: entryTagIds }),
    [allTags, entryTagIds, query],
  )

  const trimmedQuery = query.trim()
  const canCreate = canCreateTagName(allTags, query)

  async function handleAddExisting(tag: Tag) {
    const targetEntry = entryIdRef.current
    setEntryTags((prev) => [...prev, tag])
    setQuery('')
    try {
      await addTagToEntry(targetEntry, tag.id)
      emitTagsChanged()
    } catch (err) {
      setEntryTags((prev) => prev.filter((x) => x.id !== tag.id))
      console.error('Failed to add tag to entry:', err)
    }
  }

  async function handleCreateAndAdd() {
    if (!trimmedQuery) return
    const targetEntry = entryIdRef.current
    let created: Tag
    try {
      created = await createTag(trimmedQuery, randomTagColor())
    } catch (err) {
      console.error('Failed to create tag:', err)
      return
    }
    setEntryTags((prev) => [...prev, created])
    setQuery('')
    try {
      await addTagToEntry(targetEntry, created.id)
      emitTagsChanged()
    } catch (err) {
      setEntryTags((prev) => prev.filter((x) => x.id !== created.id))
      console.error('Failed to attach created tag to entry:', err)
    }
  }

  async function handleRemove(tag: Tag) {
    const targetEntry = entryIdRef.current
    setEntryTags((prev) => prev.filter((x) => x.id !== tag.id))
    try {
      await removeTagFromEntry(targetEntry, tag.id)
      emitTagsChanged()
    } catch (err) {
      setEntryTags((prev) => [...prev, tag])
      console.error('Failed to remove tag from entry:', err)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0) void handleAddExisting(suggestions[0])
      else if (canCreate) void handleCreateAndAdd()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Backspace' && query === '' && entryTags.length > 0) {
      void handleRemove(entryTags[entryTags.length - 1])
    }
  }

  return (
    <div
      role="dialog"
      aria-label={t('tags_popover.dialog_aria')}
      className="border-border-default bg-elevated w-70 rounded-xl border p-2 shadow-lg"
    >
      {entryTags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1 px-1">
          {entryTags.map((tag) => (
            <span
              key={tag.id}
              className="border-border-default text-fg-secondary text-2xs inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium"
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
                onClick={() => void handleRemove(tag)}
                className="text-fg-muted hover:text-fg ml-0.5 flex items-center justify-center rounded-full outline-none"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

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
                className="h-[7px] w-[7px] shrink-0 rounded-full"
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
              <span className="truncate">{t('tags_popover.create', { name: trimmedQuery })}</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
