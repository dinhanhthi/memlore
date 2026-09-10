import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus } from 'lucide-react'
import { useActiveTab, useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useTags } from '../../hooks/useTags'
import type { Tag } from '../../types/journal'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { cn } from '../../lib/cn'
import { useIsTruncated } from '../../hooks/useIsTruncated'
import { EntryList, type EntryListTagFilter } from '../layout/EntryList'
import { SecondPanel } from '../layout/SecondPanel'
import { isHex6 } from '../../lib/tagColors'
import { sortTagsByName } from '../../lib/tagPicker'
import { TagEditorModal } from './TagEditorModal'
import TagTableSkeleton from './TagTableSkeleton'

// ─── Tag Table Row ───────────────────────────────────────────────────────────

interface TableRowProps {
  tag: Tag
  count: number
  selected: boolean
  onEdit: (tag: Tag) => void
  onClick: () => void
}

const TagTableRow = memo(function TagTableRow({
  tag,
  count,
  selected,
  onEdit,
  onClick,
}: TableRowProps) {
  const dotColor = isHex6(tag.color) ? tag.color : 'var(--color-accent)'
  // Only show the full-label tooltip when the name is actually clipped.
  const nameRef = useRef<HTMLSpanElement>(null)
  const isTruncated = useIsTruncated(nameRef, [tag.name])

  return (
    <tr
      onClick={onClick}
      aria-selected={selected}
      className={cn(
        'border-border-default cursor-pointer border-b last:border-b-0',
        // Neutral near-white hover (white tint in dark mode) instead of an
        // accent wash; black tint in light mode keeps the hover visible there.
        !selected && 'dark:hover:bg-elevated hover:bg-surface-row-hover',
        count === 0 ? 'opacity-50' : '',
        selected && 'bg-elevated dark:bg-surface-hi',
      )}
    >
      {/* Accent left stripe marks the selected row — mirrors the selected
          entry card. Painted on the first cell (box-shadow on a collapsed
          <tr> is unreliable in WebKit). */}
      <td className={cn('px-3 py-2')}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            style={{ backgroundColor: dotColor }}
            className="inline-block h-2 w-4 shrink-0 rounded-full"
          />
          <Tooltip
            content={tag.name}
            placement="top"
            disabled={!isTruncated}
            className="min-w-0 flex-1"
          >
            <span ref={nameRef} className="text-fg block w-full truncate text-sm font-medium">
              {tag.name}
            </span>
          </Tooltip>
        </div>
      </td>
      <td className="text-fg-muted px-3 py-2 text-right text-sm">{count}</td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          aria-label={`Edit tag ${tag.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(tag)
          }}
          className="text-fg-muted hover:text-fg hover:bg-accent-soft inline-flex cursor-pointer items-center justify-center rounded-md p-1.5 transition-colors duration-(--motion-duration-fast)"
        >
          <Pencil className="size-4" />
        </button>
      </td>
    </tr>
  )
})

// ─── TagsView ────────────────────────────────────────────────────────────────

type EditorState = { mode: 'create' } | { mode: 'edit'; tag: Tag; count: number }

export function TagsView() {
  const { t } = useTranslation('nav')
  const { tagsWithCounts, isLoading, error, createTag, updateTag, deleteTag } = useTags()
  const updateActiveTab = useUpdateActiveTab()
  const activeTab = useActiveTab()
  const [editor, setEditor] = useState<EditorState | null>(null)

  const selectedTagId = activeTab?.selectedTagId ?? null

  const displayedTagsWithCounts = useMemo(() => {
    const countById = new Map(tagsWithCounts.map(([tag, count]) => [tag.id, count]))
    // Show every tag, including 0-entry ones — the row renders dimmed
    // (opacity-50) rather than being hidden.
    return sortTagsByName(tagsWithCounts.map(([tag]) => tag)).map(
      (tag) => [tag, countById.get(tag.id) ?? 0] as [Tag, number],
    )
  }, [tagsWithCounts])

  const { totalEntries, tagCount } = useMemo(() => {
    let total = 0
    for (const [, count] of tagsWithCounts) {
      total += count
    }
    return { totalEntries: total, tagCount: tagsWithCounts.length }
  }, [tagsWithCounts])

  const selectedTagEntry = useMemo(
    () =>
      selectedTagId != null ? (tagsWithCounts.find(([t]) => t.id === selectedTagId) ?? null) : null,
    [selectedTagId, tagsWithCounts],
  )

  // Track whether we've ever observed a non-empty, non-loading snapshot.
  // `useTags` can briefly emit `[]` mid-refresh while `isLoading === false`
  // (e.g. right after `emitTagsChanged()`); during that transient window
  // the stale-filter cleanup below would incorrectly kick the user back
  // to cloud view. Only clear once we've seen a real, populated snapshot
  // that confirmably lacks the selected tag.
  const hasSeenLoadedRef = useRef(false)
  useEffect(() => {
    if (!isLoading && tagsWithCounts.length > 0) {
      hasSeenLoadedRef.current = true
    }
  }, [isLoading, tagsWithCounts.length])

  // Selected tag no longer exists (deleted from another surface) — drop the
  // filter so the user isn't stuck on a stale empty list. Runs after render
  // to avoid setState-during-render warnings.
  useEffect(() => {
    if (
      selectedTagId != null &&
      !selectedTagEntry &&
      !isLoading &&
      hasSeenLoadedRef.current &&
      tagsWithCounts.length > 0
    ) {
      updateActiveTab({ selectedTagId: null, selectedEntryId: null })
    }
  }, [selectedTagId, selectedTagEntry, isLoading, tagsWithCounts.length, updateActiveTab])

  const handleSelectTag = useCallback(
    (tag: Tag) => {
      // Clicking the already-selected tag clears the filter — the entry list
      // header (which used to carry the "×" clear button) is hidden in this
      // view, so the table row is the only clear affordance.
      updateActiveTab({
        selectedTagId: tag.id === selectedTagId ? null : tag.id,
        selectedEntryId: null,
      })
    },
    [updateActiveTab, selectedTagId],
  )

  const handleClearTag = useCallback(() => {
    updateActiveTab({ selectedTagId: null, selectedEntryId: null })
  }, [updateActiveTab])

  // Stable `tagFilter` reference passed to `EntryList`. Avoids the
  // child's `useCallback`/`useMemo` deps invalidating on every render.
  const tagFilter: EntryListTagFilter | null = useMemo(() => {
    if (!selectedTagEntry) return null
    const [tag] = selectedTagEntry
    return {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      onClear: handleClearTag,
    }
  }, [selectedTagEntry, handleClearTag])

  const handleEdit = (tag: Tag) => {
    const count = tagsWithCounts.find(([t]) => t.id === tag.id)?.[1] ?? 0
    setEditor({ mode: 'edit', tag, count })
  }

  const handleSave = async (patch: { name: string; color: string | null }) => {
    if (editor?.mode === 'create') {
      await createTag(patch.name, patch.color ?? undefined)
    } else if (editor?.mode === 'edit') {
      await updateTag(editor.tag.id, { name: patch.name, color: patch.color })
    }
  }

  const handleDelete = async () => {
    if (editor?.mode === 'edit') {
      const wasActiveFilter = editor.tag.id === selectedTagId
      await deleteTag(editor.tag.id)
      // Only clear the filter after the delete actually succeeded —
      // otherwise a rejection would leave the user filtered out of a
      // tag that still exists.
      if (wasActiveFilter) {
        updateActiveTab({ selectedTagId: null, selectedEntryId: null })
      }
    }
  }

  if (isLoading) {
    return (
      <SecondPanel>
        <TagTableSkeleton />
      </SecondPanel>
    )
  }

  if (error) {
    return (
      <SecondPanel>
        <div role="alert" className="flex h-full items-center justify-center px-6">
          <p className="text-danger-text text-sm">{error}</p>
        </div>
      </SecondPanel>
    )
  }

  // ─── Unified layout: tag table on top, entry list below ───────────────────
  // Mirrors the Calendar page — the tag table fills the column until a tag is
  // selected, then collapses to a bounded scroll region on top so the entry
  // list below (scoped to that tag) gets the majority of the height.
  const tagSelected = tagFilter != null

  return (
    <SecondPanel>
      <div className={cn('flex min-h-0 flex-col', tagSelected ? 'max-h-1/2 shrink-0' : 'flex-1')}>
        <div className="flex h-full w-full flex-col">
          {/* Empty state */}
          {tagCount === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
              <p className="font-display text-fg text-xl font-bold">{t('tags_view.empty_title')}</p>
              <p className="text-fg-muted text-sm">{t('tags_view.empty_hint')}</p>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="size-4" />}
                onClick={() => setEditor({ mode: 'create' })}
              >
                {t('tags_view.new_tag')}
              </Button>
            </div>
          )}

          {/* Tag table — semantic <table> for proper screen-reader column/row mapping.
            Split into a fixed header table + a scrollable body table (both
            `table-fixed` with an identical <colgroup>) so the scrollbar spans
            only the tag rows, never the "Tag"/"Entries" header row. */}
          {tagCount > 0 && (
            <div className="flex h-full w-full flex-col">
              <table className="w-full table-fixed border-collapse">
                {/* Header column widths are the INVERSE of the body's: the
                      short "Tag" label gets the least width, "Entries" takes the
                      flex space. The counts still line up under "ENTRIES" because
                      both header + body right-align against the same fixed w-16
                      action column. */}
                <colgroup>
                  <col className="w-20" />
                  <col />
                  <col className="w-12" />
                </colgroup>
                <thead>
                  <tr className="border-border-default border-b">
                    <th
                      scope="col"
                      className="text-fg-muted px-3 py-2 text-left text-xs tracking-wider whitespace-nowrap uppercase"
                    >
                      {t('tags_view.col_tag')}{' '}
                      <span className="text-fg-muted ml-1 font-normal">{tagCount}</span>
                    </th>
                    <th
                      scope="col"
                      className="text-fg-muted px-3 py-2 text-right text-xs tracking-wider whitespace-nowrap uppercase"
                    >
                      {t('tags_view.col_entries')}{' '}
                      <span className="text-fg-muted ml-1 font-normal">{totalEntries}</span>
                    </th>
                    <th scope="col" className="py-2 pr-3">
                      <div className="flex justify-end">
                        <button
                          type="button"
                          aria-label={t('tags_view.new_tag')}
                          onClick={() => setEditor({ mode: 'create' })}
                          className="gradient-primary shadow-primary-glow text-fg-inverse inline-flex size-7 cursor-pointer items-center justify-center rounded-full transition-[filter] duration-(--motion-duration-fast) hover:brightness-[1.07]"
                        >
                          <Plus className="size-4" />
                        </button>
                      </div>
                    </th>
                  </tr>
                </thead>
              </table>
              <RestoredScroll view="tags" className="min-h-0 flex-1 overflow-y-auto">
                <table className="w-full table-fixed border-collapse">
                  <colgroup>
                    <col />
                    <col className="w-14" />
                    <col className="w-12" />
                  </colgroup>
                  <tbody>
                    {displayedTagsWithCounts.map(([tag, count]) => (
                      <TagTableRow
                        key={tag.id}
                        tag={tag}
                        count={count}
                        selected={tag.id === selectedTagId}
                        onEdit={handleEdit}
                        onClick={() => handleSelectTag(tag)}
                      />
                    ))}
                  </tbody>
                </table>
              </RestoredScroll>
            </div>
          )}
        </div>
      </div>

      {/* Entry list — appears below the tag table once a tag is selected,
          taking the majority of the column height. Wrapped in a padded, rounded
          card panel like the Calendar page's entries panel. */}
      {tagFilter && (
        <div className="border-elevated min-h-0 flex-1 border-t">
          <div className="flex h-full flex-col overflow-hidden">
            <EntryList framed={false} tagFilter={tagFilter} hideHeader />
          </div>
        </div>
      )}

      {editor && (
        <TagEditorModal
          tag={editor.mode === 'edit' ? editor.tag : null}
          entryCount={editor.mode === 'edit' ? editor.count : 0}
          onSave={handleSave}
          onDelete={editor.mode === 'edit' ? handleDelete : undefined}
          onClose={() => setEditor(null)}
        />
      )}
    </SecondPanel>
  )
}
