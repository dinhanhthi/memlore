import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tag as TagIcon, X } from 'lucide-react'
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size as floatingSize,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react'
import { Modal } from '../common/Modal'
import type { Journal, Tag } from '../../types/journal'
import { TextInput } from '../common/TextInput'
import { Button } from '../common/Button'
import { Toggle } from '../settings/Toggle'
import { cn } from '../../lib/cn'
import { useTags } from '../../hooks/useTags'
import { listJournalAutoTags } from '../../lib/tauri'
import { canCreateTagName, filterTagSuggestions, sortTagsByName } from '../../lib/tagPicker'
import { randomTagColor, isHex6 } from '../../lib/tagColors'
import { getRandomJournalColor, PRESET_COLORS } from '../../lib/journalColors'

interface JournalFormProps {
  journal: Journal | null // null = create mode, journal = edit mode
  onSave: (
    name: string,
    color: string | undefined,
    /** Tag ids to auto-attach to every new entry in this journal.
     *  - `undefined` (in edit mode) = leave the set unchanged.
     *  - `string[]` = replace with exactly this list (empty array clears).
     */
    autoTagIds: string[] | undefined,
  ) => void
  onCancel: () => void
  externalError?: string | null
}

function dotColor(tag: Tag): string {
  return isHex6(tag.color) ? tag.color : 'var(--color-accent)'
}

export function JournalForm({ journal, onSave, onCancel, externalError }: JournalFormProps) {
  const { t } = useTranslation('settings')
  const { tags, createTag, refresh: refreshTags } = useTags()

  const [name, setName] = useState(journal?.name ?? '')
  const [color, setColor] = useState(() =>
    journal === null ? getRandomJournalColor() : (journal.color ?? PRESET_COLORS[0].hex),
  )
  const [colorEdited, setColorEdited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const displayError = externalError ?? error

  // Auto-apply tags state. In edit mode we lazily fetch the current set
  // via `listJournalAutoTags` — kept off the Journal struct so the journal
  // list endpoint stays a single, simple query. `originalAutoTagIds` is
  // the baseline so we can detect "no change" and pass `undefined` (leave
  // unchanged) on save instead of re-writing.
  const [originalAutoTagIds, setOriginalAutoTagIds] = useState<string[]>([])
  const [autoTagsLoaded, setAutoTagsLoaded] = useState(journal === null)
  const [autoTagEnabled, setAutoTagEnabled] = useState(false)
  const [selectedAutoTagIds, setSelectedAutoTagIds] = useState<string[]>([])
  const [tagQuery, setTagQuery] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [tagSuggestionsOpen, setTagSuggestionsOpen] = useState(false)
  const tagInputRef = useRef<HTMLInputElement>(null)
  // Merge journal auto-tags while the edit fetch is in flight.
  const [extraTags, setExtraTags] = useState<Tag[]>([])

  const tagFloating = useFloating({
    open: tagSuggestionsOpen,
    onOpenChange: setTagSuggestionsOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      floatingSize({
        apply({ rects, elements, availableHeight }) {
          Object.assign(elements.floating.style, {
            minWidth: `${rects.reference.width}px`,
          })
          elements.floating.style.setProperty(
            '--tag-suggestions-max-height',
            `${Math.min(availableHeight, 220)}px`,
          )
        },
        padding: 8,
      }),
    ],
  })
  const tagDismiss = useDismiss(tagFloating.context)
  const { getFloatingProps: getTagFloatingProps } = useInteractions([tagDismiss])

  // Pull the latest global tag list whenever the modal opens so tags
  // created in a previous journal edit are available in create mode too.
  useEffect(() => {
    void refreshTags()
  }, [refreshTags])

  // Reset auto-tag picker state when switching into create mode, and fetch
  // the existing auto-tag set when editing.
  useEffect(() => {
    if (!journal) {
      setOriginalAutoTagIds([])
      setSelectedAutoTagIds([])
      setExtraTags([])
      setAutoTagEnabled(false)
      setAutoTagsLoaded(true)
      setTagQuery('')
      setTagSuggestionsOpen(false)
      return
    }

    let cancelled = false
    setTagSuggestionsOpen(false)
    setAutoTagsLoaded(false)
    void listJournalAutoTags(journal.id).then((current) => {
      if (cancelled) return
      const ids = current.map((tag) => tag.id)
      setOriginalAutoTagIds(ids)
      setSelectedAutoTagIds(ids)
      setExtraTags(current)
      setAutoTagEnabled(ids.length > 0)
      setAutoTagsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [journal])

  const pickerTags = useMemo(() => {
    const byId = new Map(tags.map((tag) => [tag.id, tag]))
    for (const tag of extraTags) {
      byId.set(tag.id, tag)
    }
    return sortTagsByName(Array.from(byId.values()))
  }, [tags, extraTags])

  const selectedTags = useMemo(
    () =>
      selectedAutoTagIds
        .map((id) => pickerTags.find((tag) => tag.id === id))
        .filter((t): t is Tag => t != null),
    [pickerTags, selectedAutoTagIds],
  )

  const trimmedQuery = tagQuery.trim()
  const filteredTags = useMemo(
    () => filterTagSuggestions(pickerTags, { query: tagQuery, excludeIds: selectedAutoTagIds }),
    [pickerTags, selectedAutoTagIds, tagQuery],
  )
  const canCreateTag = canCreateTagName(pickerTags, tagQuery)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('journals_section.form.name_required'))
      return
    }
    if (autoTagEnabled && selectedAutoTagIds.length === 0) {
      setError(t('journals_section.form.auto_tags_required'))
      return
    }

    // Resolve the auto-apply payload:
    //  - toggle on  → the picked list (may be 1+)
    //  - toggle off → empty array (an explicit clear) ONLY if there were
    //    previously tags to clear; otherwise pass undefined to avoid a
    //    no-op DELETE.
    let resolved: string[] | undefined
    if (autoTagEnabled) {
      // No change → pass undefined so the backend leaves the set alone.
      const sameAsOriginal =
        selectedAutoTagIds.length === originalAutoTagIds.length &&
        selectedAutoTagIds.every((id) => originalAutoTagIds.includes(id))
      resolved = sameAsOriginal ? undefined : selectedAutoTagIds
    } else if (originalAutoTagIds.length > 0) {
      resolved = [] // clearing
    } else {
      resolved = undefined // never had any, still don't
    }

    onSave(trimmed, journal && !colorEdited ? (journal.color ?? undefined) : color, resolved)
  }

  async function handleCreateTag() {
    if (!trimmedQuery || tagBusy) return
    setTagBusy(true)
    try {
      const created = await createTag(trimmedQuery, randomTagColor())
      setExtraTags((prev) => {
        const without = prev.filter((tag) => tag.id !== created.id)
        return [...without, created]
      })
      setSelectedAutoTagIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]))
      setTagQuery('')
    } catch (err) {
      console.error('Failed to create tag:', err)
    } finally {
      setTagBusy(false)
    }
  }

  function handleAddTag(tagId: string) {
    setSelectedAutoTagIds((prev) => (prev.includes(tagId) ? prev : [...prev, tagId]))
    setTagQuery('')
  }

  function handleRemoveTag(tagId: string) {
    setSelectedAutoTagIds((prev) => prev.filter((id) => id !== tagId))
  }

  function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredTags.length > 0) {
        handleAddTag(filteredTags[0].id)
      } else if (canCreateTag) {
        void handleCreateTag()
      }
    } else if (e.key === 'Escape') {
      if (tagSuggestionsOpen) {
        e.stopPropagation()
        setTagSuggestionsOpen(false)
      }
    } else if (e.key === 'Backspace' && trimmedQuery === '' && selectedAutoTagIds.length > 0) {
      // Quick-remove the most recently picked tag.
      handleRemoveTag(selectedAutoTagIds[selectedAutoTagIds.length - 1])
    }
  }

  return (
    <Modal onClose={onCancel} maxWidth={460}>
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <Modal.Header>
          <span className="font-title text-xl font-semibold">
            {journal ? t('journals_section.form.title_edit') : t('journals_section.form.title_new')}
          </span>
        </Modal.Header>
        <Modal.Body fitContent className="flex flex-col gap-4">
          {/* Name input */}
          <div>
            <label htmlFor="journal-name" className="text-fg mb-1 block text-sm font-medium">
              {t('journals_section.form.name_label')}
            </label>
            <TextInput
              id="journal-name"
              value={name}
              onChange={(v) => {
                setName(v)
                setError(null)
              }}
              placeholder={t('journals_section.form.name_placeholder')}
              autoFocus
            />
            {displayError && <p className="text-danger-text mt-1 text-xs">{displayError}</p>}
          </div>

          {/* Color picker */}
          <div>
            <span className="text-fg mb-2 block text-sm font-medium">
              {t('journals_section.form.color_label')}
            </span>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  aria-label={c.name}
                  onClick={() => {
                    setColorEdited(true)
                    setColor(c.hex)
                  }}
                  className={cn(
                    'h-8 w-8 rounded-full transition-[filter] duration-200 hover:brightness-110',
                    color === c.hex && 'ring-focus-ring shadow-sm ring-2 ring-offset-2',
                  )}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>
          </div>

          {/* Auto-apply tags */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-fg block text-sm font-medium">
                  {t('journals_section.form.auto_tags_label')}
                </span>
                <span className="text-fg-muted block text-xs">
                  {t('journals_section.form.auto_tags_hint')}
                </span>
              </div>
              <Toggle
                checked={autoTagEnabled}
                disabled={!autoTagsLoaded}
                onChange={(next) => {
                  setAutoTagEnabled(next)
                  setError(null)
                  if (!next) {
                    setTagQuery('')
                    setTagSuggestionsOpen(false)
                  }
                }}
                ariaLabel={t('journals_section.form.auto_tags_label')}
              />
            </div>

            {autoTagEnabled && (
              <div className="flex flex-col gap-2">
                {selectedTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {selectedTags.map((tag) => (
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
                          aria-label={t('journals_section.form.auto_tags_remove_aria', {
                            name: tag.name,
                          })}
                          onClick={() => handleRemoveTag(tag.id)}
                          className="text-fg-muted hover:text-fg ml-0.5 flex items-center justify-center rounded-full outline-none"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <div
                  ref={tagFloating.refs.setReference}
                  className="border-border-default flex items-center gap-2 rounded-lg border px-2 py-1.5"
                >
                  <TagIcon className="text-fg-muted size-3.5 shrink-0" />
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={tagQuery}
                    onFocus={() => setTagSuggestionsOpen(true)}
                    onChange={(e) => {
                      setTagQuery(e.target.value)
                      setTagSuggestionsOpen(true)
                    }}
                    onKeyDown={handleTagKeyDown}
                    aria-label={t('journals_section.form.auto_tags_search_aria')}
                    aria-expanded={tagSuggestionsOpen}
                    aria-autocomplete="list"
                    placeholder={t('journals_section.form.auto_tags_search_placeholder')}
                    className="xj-input-bare text-fg placeholder:text-fg-muted flex-1 border-0 bg-transparent text-xs outline-none"
                  />
                </div>

                {tagSuggestionsOpen && (
                  <FloatingPortal>
                    <div
                      ref={tagFloating.refs.setFloating}
                      style={tagFloating.floatingStyles}
                      className="z-1100"
                      {...getTagFloatingProps()}
                    >
                      <ul
                        role="listbox"
                        className="border-border-default bg-elevated max-h-(--tag-suggestions-max-height) overflow-y-auto rounded-xl border p-1 shadow-lg"
                      >
                        {filteredTags.length === 0 && !canCreateTag && (
                          <li className="text-fg-muted text-2xs px-2 py-1.5">
                            {pickerTags.length === 0
                              ? t('journals_section.form.auto_tags_empty')
                              : selectedTags.length > 0 && trimmedQuery === ''
                                ? t('journals_section.form.auto_tags_all_added')
                                : t('journals_section.form.auto_tags_no_matches')}
                          </li>
                        )}

                        {filteredTags.map((tag) => (
                          <li key={tag.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={false}
                              onClick={() => handleAddTag(tag.id)}
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

                        {canCreateTag && (
                          <li>
                            <button
                              type="button"
                              role="option"
                              aria-selected={false}
                              disabled={tagBusy}
                              onClick={() => void handleCreateTag()}
                              className="text-accent hover:bg-accent-soft flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none disabled:opacity-50"
                            >
                              <span aria-hidden="true">+</span>
                              <span className="truncate">
                                {t('journals_section.form.auto_tags_create', {
                                  name: trimmedQuery,
                                })}
                              </span>
                            </button>
                          </li>
                        )}
                      </ul>
                    </div>
                  </FloatingPortal>
                )}
              </div>
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('journals_section.form.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm">
            {journal ? t('journals_section.form.save') : t('journals_section.form.create')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
