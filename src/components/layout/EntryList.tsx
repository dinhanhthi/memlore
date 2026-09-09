import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { useSelectedEntryId, useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useRestoredScroll } from '../../hooks/useRestoredScroll'
import { getTabScroll, tabScrollKey } from '../../lib/tabScrollPositions'
import { useTabStore } from '../../stores/tabStore'
import { useEntries } from '../../hooks/useEntries'
import { EMPTY_TAGS, useEntryTags } from '../../hooks/useEntryTags'
import { useTemplates } from '../../hooks/useTemplates'
import { formatGroupDateLabel, groupEntriesByDate, toISODate } from '../../lib/dates'
import { resolveFirstDayOfWeek } from '../../lib/firstDayOfWeek'
import { scrollIntoViewNearest } from '../../lib/scrollIntoViewNearest'
import { useTags } from '../../hooks/useTags'
import { isHex6 } from '../../lib/tagColors'
import { toast } from '../../lib/toast'
import { AiSummaryTrigger } from '../ai/AiSummaryTrigger'
import { useChatDraftStore } from '../../stores/chatDraftStore'
import { useJournalStore } from '../../stores/journalStore'
import { useTemplateStore } from '../../stores/templateStore'
import { getEntryListFilter, useUiStore, type EntryListViewKey } from '../../stores/uiStore'
import type { Template } from '../../types/template'
import type { Entry } from '../../types/entry'
import type { EntryTimeRange, EntrySort } from '../../types/pagination'
import type { LockFilter, TimeRange } from '../../lib/entryFilterSort'
import {
  coerceLockFilter,
  resolveLockFilterVisibility,
  timeRangeBounds,
} from '../../lib/entryFilterSort'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { Paginator } from '../common/Paginator'
import { EntryCard } from '../entries/EntryCard'
import { ENTRY_CARD_IDLE_BG } from '../entries/entryCardIdleBg'
import EntryListSkeleton from '../entries/EntryListSkeleton'
import { TemplatePicker } from '../templates/TemplatePicker'
import { EntryListFilterRow } from './EntryListFilterRow'
import { SecondPanel } from './SecondPanel'

export interface EntryListTagFilter {
  id: string
  name: string
  /** 6-digit hex (#RRGGBB) or null. */
  color: string | null
  /** Called when the user clicks the "x" on the filter chip — host should
   * clear `selectedTagId` on the active tab. */
  onClear: () => void
}

interface EntryListProps {
  /** When set, list is scoped to entries tagged with `tagFilter.id`
   * (optionally narrowed by the view's journal filter). New entries created
   * from this list are auto-tagged with `tagFilter.id`. */
  tagFilter?: EntryListTagFilter | null
  /** Optional side-effect when the user clicks an entry card (not fired on
   * auto-select after creating a new entry). Used by hosts that render an
   * internal multi-column split (Tags, Calendar) to collapse the main
   * sidebar once the user has drilled into a single entry. */
  onEntrySelected?: () => void
  /** Suppress the context/count header and filter row entirely. Used by the
   * Tags view, where the tag table above already conveys the active tag and
   * per-tag filtering isn't offered. */
  hideHeader?: boolean
  /** Wrap the list in the shared `SecondPanel` frame. Hosts that already render
   * their own frame and embed the list as a sub-section (the Tags view's lower
   * half) pass `false` — a nested gutter + hairline would read as a frame
   * inside a frame. */
  framed?: boolean
}

/**
 * Map the UI-layer TimeRange discriminated union to the backend's flat
 * EntryTimeRange string plus optional explicit timestamp bounds.
 *
 * For named ranges, `range` carries the semantic token and bounds are null.
 * For custom ranges, `range` is set to 'all' and the resolved Unix-second
 * bounds are returned as `fromTs`/`toTs` so the backend can apply them
 * directly via the `custom_range` override path.
 * If a custom range has only one bound set (partial), we degrade to 'all'
 * because the backend requires both-or-nothing.
 */
function toBackendRangeWithBounds(r: TimeRange): {
  range: EntryTimeRange
  fromTs: number | null
  toTs: number | null
} {
  switch (r.kind) {
    case 'all':
      return { range: 'all', fromTs: null, toTs: null }
    case 'thisWeek':
      return { range: 'thisWeek', fromTs: null, toTs: null }
    case 'thisMonth':
      return { range: 'thisMonth', fromTs: null, toTs: null }
    case 'thisYear':
      return { range: 'thisYear', fromTs: null, toTs: null }
    case 'custom': {
      const bounds = timeRangeBounds(r)
      if (bounds === null) {
        // Partial custom range — degrade to 'all'
        return { range: 'all', fromTs: null, toTs: null }
      }
      return { range: 'all', fromTs: bounds.from, toTs: bounds.toExclusive }
    }
  }
}

/**
 * The list's outer box: the shared `SecondPanel` frame when the list *is* the
 * second panel, or a bare flex column when a host embeds it inside its own
 * frame (Tags view) — nesting the frame would double the gutter + hairline.
 */
function ListFrame({ framed, children }: { framed: boolean; children: ReactNode }) {
  if (!framed) {
    return <div className="flex h-full flex-col overflow-hidden">{children}</div>
  }
  return <SecondPanel>{children}</SecondPanel>
}

export function EntryList({
  tagFilter = null,
  onEntrySelected,
  hideHeader = false,
  framed = true,
}: EntryListProps) {
  const { t, i18n } = useTranslation('nav')
  const { attachTag } = useTags()
  const { templates } = useTemplates()
  const enqueuePendingTemplate = useTemplateStore((s) => s.enqueuePendingTemplate)
  const selectedEntryId = useSelectedEntryId()
  const tabId = useTabStore((s) => s.activeTabId)
  // Refs for the auto-scroll-on-refresh behavior. We deliberately do NOT
  // use `el.scrollIntoView({ block: 'nearest' })` — that walks every
  // scrollable ancestor and on Tauri's WKWebView occasionally bubbles up
  // to shift the entire window content (the title bar gets clipped). We
  // scroll the EntryList's own overflow container directly so the scroll
  // never escapes this component.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const selectedCardRef = useRef<HTMLDivElement | null>(null)
  const updateActiveTab = useUpdateActiveTab()
  const journals = useJournalStore((s) => s.journals)
  const templatePickerOpen = useUiStore((s) => s.templatePickerOpen)
  const setTemplatePickerOpen = useUiStore((s) => s.setTemplatePickerOpen)
  // Starred filter: plain component state, not uiStore — intentionally does
  // NOT persist across app restarts or survive a tab switch (avoids the
  // "hidden filter" trap where a stale toggle silently hides entries).
  const [starred, setStarred] = useState(false)

  // viewKey and filterState must be computed BEFORE the useEntries call.
  // Starred does NOT get its own viewKey — it reuses 'all' so journal/range/
  // sort/lock filter state stays intact when the user toggles it.
  const viewKey: EntryListViewKey = tagFilter ? 'tags' : 'all'
  const filterState = useUiStore((s) => getEntryListFilter(s, viewKey))
  const setEntryListRange = useUiStore((s) => s.setEntryListRange)
  const setEntryListSort = useUiStore((s) => s.setEntryListSort)
  const setEntryListLockFilter = useUiStore((s) => s.setEntryListLockFilter)
  const setEntryListJournalId = useUiStore((s) => s.setEntryListJournalId)
  const secondLockEnabled = useSecondLockStore((s) => s.isEnabled)
  const secondLockSessionUnlocked = useSecondLockStore((s) => s.isSessionUnlocked)
  const showExistence = useSecondLockStore((s) => s.showExistence)
  const invisibleSessionUnlocked = useInvisibleLockStore((s) => s.activeVaultId != null)

  const lockFilterVisibility = useMemo(
    () =>
      resolveLockFilterVisibility({
        secondLockEnabled,
        secondLockSessionUnlocked,
        showExistence,
        invisibleSessionUnlocked,
      }),
    [secondLockEnabled, secondLockSessionUnlocked, showExistence, invisibleSessionUnlocked],
  )
  const backendLockFilter: LockFilter = useMemo(
    () => coerceLockFilter(filterState.lockFilter, lockFilterVisibility),
    [filterState.lockFilter, lockFilterVisibility],
  )

  useEffect(() => {
    if (backendLockFilter !== filterState.lockFilter) {
      setEntryListLockFilter(viewKey, backendLockFilter)
    }
  }, [backendLockFilter, filterState.lockFilter, setEntryListLockFilter, viewKey])

  const firstDayOfWeek = useMemo(() => resolveFirstDayOfWeek(i18n.language), [i18n.language])
  const { range: backendRange, fromTs, toTs } = toBackendRangeWithBounds(filterState.range)
  const backendSort: EntrySort = filterState.sort
  const backendFirstDayOfWeek: 0 | 1 = firstDayOfWeek === 0 ? 0 : 1
  const effectiveJournalId = filterState.journalId

  const useEntriesArgs = tagFilter
    ? {
        tagId: tagFilter.id,
        journalId: effectiveJournalId,
        favoritesOnly: starred,
        sort: backendSort,
        range: backendRange,
        fromTs,
        toTs,
        firstDayOfWeek: backendFirstDayOfWeek,
        lockFilter: backendLockFilter,
      }
    : starred
      ? {
          favoritesOnly: true as const,
          journalId: effectiveJournalId,
          sort: backendSort,
          range: backendRange,
          fromTs,
          toTs,
          firstDayOfWeek: backendFirstDayOfWeek,
          lockFilter: backendLockFilter,
        }
      : {
          journalId: effectiveJournalId,
          sort: backendSort,
          range: backendRange,
          fromTs,
          toTs,
          firstDayOfWeek: backendFirstDayOfWeek,
          lockFilter: backendLockFilter,
        }

  const {
    entries,
    total,
    totalPages,
    page,
    setPage,
    isLoading,
    error,
    createEntry,
    deleteEntry,
    toggleFavorite,
  } = useEntries(useEntriesArgs)
  const entryTags = useEntryTags(entries.map((entry) => entry.id))

  const scrollKey = tabId
    ? tabScrollKey(tabId, tagFilter ? 'tags' : 'entries', tagFilter?.id)
    : null
  useRestoredScroll(scrollContainerRef, scrollKey, { ready: !isLoading })
  // First load after remount: if a saved scroll exists, skip the
  // selected-card auto-scroll so it cannot overwrite restore.
  const skipAutoScrollOnce = useRef(true)
  const skipAutoScrollKeyRef = useRef(scrollKey)
  if (skipAutoScrollKeyRef.current !== scrollKey) {
    skipAutoScrollKeyRef.current = scrollKey
    skipAutoScrollOnce.current = true
  }

  // Auto-scroll the selected entry into view whenever the list refreshes.
  // Triggers on: initial selection mount, page change, view switch,
  // selectedEntryId change. Does NOT depend on `entries` reference —
  // in-place patches (auto-save, photo insert) update items in place
  // without changing array identity, and even if they did, we don't
  // want every micro-update to nudge scroll position.
  useEffect(() => {
    if (!selectedEntryId || isLoading) return
    if (skipAutoScrollOnce.current) {
      skipAutoScrollOnce.current = false
      if (scrollKey != null && getTabScroll(scrollKey) !== undefined) return
    }
    const container = scrollContainerRef.current
    const card = selectedCardRef.current
    if (!container || !card) return
    const raf = requestAnimationFrame(() => {
      scrollIntoViewNearest(container, card)
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedEntryId, isLoading, scrollKey])

  const journalMap = useMemo(() => {
    const map = new Map<string, (typeof journals)[0]>()
    for (const j of journals) map.set(j.id, j)
    return map
  }, [journals])

  // "Recently edited" sort would scramble the date-keyed groups (an
  // entry edited today but dated last year would render in the old
  // group). Fall back to a flat list in that mode.
  const flatList = filterState.sort === 'recentlyEdited'
  const grouped = useMemo(
    () => (flatList ? null : groupEntriesByDate(entries)),
    [flatList, entries],
  )

  const groupLabelFor = (
    group: string,
    firstEntry: Entry,
  ): { relative: string | null; label: string } => {
    if (group === 'today' || group === 'yesterday') {
      return {
        relative: t(group === 'today' ? 'entry_list.today' : 'entry_list.yesterday'),
        label: formatGroupDateLabel(toISODate(firstEntry.entry_date), i18n.language),
      }
    }
    return { relative: null, label: formatGroupDateLabel(group, i18n.language) }
  }

  const filterContextLabel = tagFilter
    ? t('entry_list.context.tagged')
    : starred
      ? t('entry_list.context.starred')
      : t('entry_list.context.all')

  // count reflects TOTAL across all pages, not just the current page slice.
  const count = total
  const tagFilterDot =
    tagFilter && isHex6(tagFilter.color) ? tagFilter.color : 'var(--color-accent)'

  // Empty-state determination (server-side filtering, so use total and filter flags).
  const hasFilter =
    tagFilter != null ||
    starred ||
    effectiveJournalId !== null ||
    filterState.range.kind !== 'all' ||
    backendLockFilter !== 'all'
  const showFilterMismatch = total === 0 && hasFilter

  const paginatorLabel = tagFilter?.name ?? (starred ? 'favorites' : 'entries')

  const handleDeleteEntry = useCallback(
    async (id: string) => {
      // Clear the selection first so the editor doesn't keep showing
      // the now-deleted entry's content. The list itself reacts to
      // emitEntriesChanged() inside deleteEntry().
      if (selectedEntryId === id) {
        updateActiveTab({ selectedEntryId: null })
      }
      await deleteEntry(id)
    },
    [deleteEntry, selectedEntryId, updateActiveTab],
  )

  const createEntryWithOptionalTemplate = useCallback(
    async (template: Template | null, seedHtml?: string) => {
      const targetJournalId = effectiveJournalId ?? journals[0]?.id
      if (!targetJournalId) return
      try {
        const newEntry = await createEntry({
          journal_id: targetJournalId,
          entry_date: Math.floor(Date.now() / 1000),
        })
        if (template) {
          enqueuePendingTemplate(newEntry.id, template)
        } else if (seedHtml) {
          useChatDraftStore.getState().enqueuePendingChatDraft(newEntry.id, seedHtml)
        }
        // When listing is scoped to a tag, every new entry created from
        // this surface inherits that tag — the user explicitly entered
        // the tag's filtered list, so creating a one-off untagged entry
        // here would feel like a bug.
        //
        // If the attach fails after the entry has been created, surface
        // the error AND clear the tag filter so the user can still see
        // (and edit) the now-untagged entry they just created — instead
        // of having it silently vanish from the filtered list.
        if (tagFilter) {
          try {
            await attachTag(newEntry.id, tagFilter.id)
          } catch (err) {
            console.error('Failed to auto-attach filter tag:', err)
            toast(`Created entry, but couldn't apply tag "${tagFilter.name}".`)
            tagFilter.onClear()
          }
        }
        updateActiveTab({ selectedEntryId: newEntry.id })
      } catch (err) {
        console.error('Failed to create entry:', err)
      }
    },
    [
      effectiveJournalId,
      journals,
      createEntry,
      enqueuePendingTemplate,
      updateActiveTab,
      tagFilter,
      attachTag,
    ],
  )

  const handleTemplateSelected = async (template: Template) => {
    setTemplatePickerOpen(false)
    // The "blank" predefined template intentionally carries empty content —
    // don't enqueue it, just create a plain entry. The name field stores the
    // slug key ('blank') now that display names are resolved via i18n.
    const isBlank = template.name === 'blank' && template.is_predefined
    await createEntryWithOptionalTemplate(isBlank ? null : template)
  }

  // The ⌘N shortcut bypasses the picker and creates a blank entry directly —
  // same fast-path the keyboard shortcut has always had.
  useEffect(() => {
    const handler = (e: Event) => {
      const seedHtml = (e as CustomEvent<{ seedHtml?: string }>).detail?.seedHtml
      void createEntryWithOptionalTemplate(null, seedHtml)
    }
    window.addEventListener('memlore:new-entry', handler)
    return () => window.removeEventListener('memlore:new-entry', handler)
  }, [createEntryWithOptionalTemplate])

  return (
    <ListFrame framed={framed}>
      {/* Header — filter context and count */}
      {/* SuperX list header: same elevated rail as the column, hairline divider */}
      {!hideHeader && (
        <div
          className={cn(
            'border-border-default flex shrink-0 flex-col gap-2.5 border-b px-4 py-3.5',
          )}
        >
          <div className="min-w-0">
            <div className="text-fg-muted text-xs font-medium tracking-[0.4px]">
              {filterContextLabel}
            </div>
            {tagFilter ? (
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: tagFilterDot }}
                  className="inline-block size-2 shrink-0 rounded-full"
                />
                <span className="font-title text-fg truncate text-xl font-extrabold tracking-[-.4px]">
                  {tagFilter.name}
                </span>
                <button
                  type="button"
                  aria-label={t('entry_list.clear_tag_filter')}
                  onClick={tagFilter.onClear}
                  className="text-fg-muted hover:text-fg hover:bg-accent-soft ml-1 inline-flex items-center justify-center rounded-full p-0.5 transition-colors"
                >
                  <X className="size-3.5" />
                </button>
                {/* isLoading (query.isPending) is true only on a genuine cold
                  fetch — no cached data anywhere to serve as placeholderData
                  yet. Toggling a filter after that never hits this branch,
                  since `keepPreviousData` keeps `total` at its prior value
                  during the refetch (see the query options below). Without
                  this guard, cold mount would flash "0 entries" here. */}
                {!isLoading && (
                  <span className="text-fg-muted text-xs">
                    · {t('entry_list.entry_count', { count })}
                  </span>
                )}
              </div>
            ) : isLoading ? (
              /* h-7 + mt-0.5 = the exact box the real text-xl title occupies
                 (1.75rem line-box), so the header doesn't shift on load. */
              <div className="bg-surface-hi mt-0.5 h-7 w-28 rounded-lg motion-safe:animate-pulse" />
            ) : (
              <div className="font-title text-fg mt-0.5 text-xl font-extrabold tracking-[-.4px]">
                {t('entry_list.entry_count', { count })}
              </div>
            )}
          </div>
          {/* Filter row */}
          <EntryListFilterRow
            journalId={effectiveJournalId}
            journals={journals}
            range={filterState.range}
            sort={filterState.sort}
            lockFilter={filterState.lockFilter}
            starred={starred}
            onStarredChange={setStarred}
            onJournalChange={(nextJournalId) => {
              setEntryListJournalId(viewKey, nextJournalId)
              // Close any open entry (it may not be in the newly-scoped list).
              // Guard on the current value: the journal filter lives in uiStore,
              // not the tab NavSnapshot, so a null→null patch here would push a
              // phantom history entry that Back can't undo (see tabStore.ts C1).
              if (selectedEntryId !== null) updateActiveTab({ selectedEntryId: null })
            }}
            onRangeChange={(r) => setEntryListRange(viewKey, r)}
            onSortChange={(s) => setEntryListSort(viewKey, s)}
            onLockFilterChange={(lf) => setEntryListLockFilter(viewKey, lf)}
          />
        </div>
      )}

      {/* Body — skeleton while loading, error message, or the scrollable list */}
      {isLoading ? (
        <EntryListSkeleton flat={flatList} />
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <span className="text-danger-text text-sm">Error: {error}</span>
        </div>
      ) : (
        <>
          <div ref={scrollContainerRef} className="flex flex-1 flex-col overflow-y-auto">
            {count === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <span className="text-fg-muted text-sm">
                  {tagFilter && starred
                    ? // Tag has entries, just none starred — the tag-specific
                      // "no entries tagged X" message would be misleading here.
                      t('entry_list.empty.no_match_filter')
                    : tagFilter
                      ? t('entry_list.empty.no_tagged')
                      : starred
                        ? t('entry_list.empty.no_favorites')
                        : showFilterMismatch
                          ? t('entry_list.empty.no_match_filter')
                          : t('entry_list.empty.no_entries')}
                </span>
                {!hasFilter && (
                  <span className="text-fg-muted text-xs">{t('entry_list.empty.press_cmd_n')}</span>
                )}
              </div>
            ) : flatList ? (
              <div className="flex flex-1 flex-col">
                {entries.map((entry: Entry) => (
                  <div
                    key={entry.id}
                    ref={selectedEntryId === entry.id ? selectedCardRef : undefined}
                    className="border-border-default border-b last:border-b-0"
                  >
                    <EntryCard
                      entry={entry}
                      isSelected={selectedEntryId === entry.id}
                      onClick={() => {
                        updateActiveTab({ selectedEntryId: entry.id })
                        onEntrySelected?.()
                      }}
                      journal={journalMap.get(entry.journal_id) ?? null}
                      tags={entryTags.get(entry.id) ?? EMPTY_TAGS}
                      idleBg={ENTRY_CARD_IDLE_BG}
                      onDelete={() => handleDeleteEntry(entry.id)}
                      onToggleFavorite={() => toggleFavorite(entry.id)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-1 flex-col">
                {Array.from((grouped ?? new Map<string, Entry[]>()).entries()).map(
                  ([group, items]: [string, Entry[]]) => {
                    const groupLabel = groupLabelFor(group, items[0])
                    const entryCards = (
                      <div className="flex flex-col">
                        {items.map((entry: Entry) => (
                          <div
                            key={entry.id}
                            ref={selectedEntryId === entry.id ? selectedCardRef : undefined}
                            className="border-border-default border-b last:border-b-0"
                          >
                            <EntryCard
                              entry={entry}
                              isSelected={selectedEntryId === entry.id}
                              onClick={() => {
                                updateActiveTab({ selectedEntryId: entry.id })
                                onEntrySelected?.()
                              }}
                              journal={journalMap.get(entry.journal_id) ?? null}
                              tags={entryTags.get(entry.id) ?? EMPTY_TAGS}
                              idleBg={ENTRY_CARD_IDLE_BG}
                              onDelete={() => handleDeleteEntry(entry.id)}
                              onToggleFavorite={() => toggleFavorite(entry.id)}
                            />
                          </div>
                        ))}
                      </div>
                    )

                    return (
                      <div key={group}>
                        <AiSummaryTrigger.Root
                          entries={items.map((e: Entry) => ({
                            id: e.id,
                            title: e.title,
                            content_text: e.content_text,
                            entry_date: e.entry_date,
                          }))}
                        >
                          <div
                            className={cn(
                              'sticky top-0 z-20 flex items-center justify-between gap-2 border-b py-2 pr-0 pl-4',
                              'border-border-default bg-panel-2',
                              // Accent sweep in every skin: a plain gray header collides with
                              // the hovered entry card beneath it.
                              "before:from-accent/25 before:pointer-events-none before:absolute before:inset-0 before:bg-linear-to-r before:to-transparent before:content-['']",
                            )}
                          >
                            <div className="relative z-10 flex min-w-0 items-baseline gap-2">
                              {groupLabel.relative && (
                                <span className="text-accent text-xs font-semibold">
                                  {groupLabel.relative}
                                </span>
                              )}
                              <span className="text-fg text-2xs truncate font-mono font-medium tracking-[0.8px] uppercase">
                                {groupLabel.label}
                              </span>
                            </div>
                            <AiSummaryTrigger.Button size="sm" className="relative z-10" />
                          </div>
                          <AiSummaryTrigger.Banner />
                          {entryCards}
                        </AiSummaryTrigger.Root>
                      </div>
                    )
                  },
                )}
              </div>
            )}
          </div>

          {/* Sticky Paginator at the bottom */}
          <Paginator
            currentPage={page}
            totalPages={totalPages}
            onPageChange={setPage}
            itemLabel={paginatorLabel}
            variant="compact"
          />
        </>
      )}

      {templatePickerOpen && (
        <TemplatePicker
          templates={templates}
          onSelect={handleTemplateSelected}
          onClose={() => setTemplatePickerOpen(false)}
        />
      )}
    </ListFrame>
  )
}
