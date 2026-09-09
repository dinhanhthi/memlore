import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { useSearch } from '../../hooks/useSearch'
import { useSemanticSearch } from '../../hooks/useSemanticSearch'
import { useAiSemanticEnabled } from '../../hooks/useAiSemanticEnabled'
import { useDefaultSearchMode } from '../../hooks/useDefaultSearchMode'
import { useSearchOverlayMode } from '../../hooks/useSearchOverlayMode'
import {
  searchOverlayRetentionKey,
  shouldRetainSearchOverlayContent,
  useSearchOverlayKeepResults,
} from '../../hooks/useSearchOverlayKeepResults'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { useUpdateActiveTab } from '../../hooks/useActiveTab'
import { cn } from '../../lib/cn'
import { formatEntryDate } from '../../lib/dates'
import {
  RELEVANCE_TIER_CLASSES,
  RELEVANCE_TIER_I18N_KEY,
  scoreToRelevance,
} from '../../lib/relevance'
import { mapSearchFilters } from '../../lib/searchFiltersMapping'
import { TextInput } from '../common/TextInput'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { Toggle } from '../settings/Toggle'
import { HelpCircle, Search } from 'lucide-react'
// Hook return types are inferred — `keywordSearch.results: SearchResult[]`,
// `meaningSearch.results: SemanticHit[]` — so no top-level type imports
// are needed for the JSX.
import { highlightQuery } from '../../lib/search'
import { SearchFilterRow } from './SearchFilterRow'
import { defaultSearchUiFilters, hasAnyFilter, type SearchUiFilters } from './searchUiFilters'
import { useOverlayHostBox } from '../../lib/overlayHost'

const FOCUSABLE =
  'a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])'

export function SearchOverlay() {
  const searchOverlayOpen = useUiStore((s) => s.searchOverlayOpen)
  const { keepResults, setKeepResults } = useSearchOverlayKeepResults()
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const lockedView = useSecondLockStore((s) => s.lockedView())
  if (!shouldRetainSearchOverlayContent(searchOverlayOpen, keepResults)) return null
  return (
    <SearchOverlayContent
      key={searchOverlayRetentionKey(activeVaultId, lockedView)}
      visible={searchOverlayOpen}
      keepResults={keepResults}
      onKeepResultsChange={setKeepResults}
    />
  )
}

function SearchOverlayContent({
  visible,
  keepResults,
  onKeepResultsChange,
}: {
  visible: boolean
  keepResults: boolean
  onKeepResultsChange: (next: boolean) => void
}) {
  const setSearchOverlayOpen = useUiStore((s) => s.setSearchOverlayOpen)
  const updateActiveTab = useUpdateActiveTab()
  const { t } = useTranslation('ai')

  const [query, setQuery] = useState('')
  const [uiFilters, setUiFilters] = useState<SearchUiFilters>(defaultSearchUiFilters)
  const filtersActive = hasAnyFilter(uiFilters)
  const mappedFilters = useMemo(() => mapSearchFilters(uiFilters), [uiFilters])
  const semanticEnabled = useAiSemanticEnabled(true)
  // Settings-owned seed (SQLite). Overlay toggles never write this —
  // they go through useSearchOverlayMode so close/reopen keeps the
  // last-used session mode without changing the Settings default.
  const { mode: defaultMode, loading: defaultLoading } = useDefaultSearchMode()
  const { activeMode, setMode } = useSearchOverlayMode(defaultMode, defaultLoading, semanticEnabled)

  // Both hooks always run (Rules of Hooks), but each short-circuits on
  // an empty query — pass the live query only to the active mode so
  // only one backend command fires per debounce tick.
  const keywordSearch = useSearch(activeMode === 'keyword' ? query : '', mappedFilters)
  const meaningSearch = useSemanticSearch(activeMode === 'meaning' ? query : '', mappedFilters)
  // Read the active hook's loading/error slice directly so the JSX
  // branches below can use the typed `keywordSearch.results` /
  // `meaningSearch.results` slices without type-asserting away the
  // discriminated union.
  const isLoading = activeMode === 'keyword' ? keywordSearch.isLoading : meaningSearch.isLoading
  const error = activeMode === 'keyword' ? keywordSearch.error : meaningSearch.error
  const resultCount =
    activeMode === 'keyword' ? keywordSearch.results.length : meaningSearch.results.length

  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hostBox = useOverlayHostBox()

  // Auto-focus input when the overlay becomes visible (reopen included).
  useEffect(() => {
    if (!visible) return
    inputRef.current?.focus({ preventScroll: true })
  }, [visible])

  // Esc closes overlay — only while visible so a hidden retain-mount
  // does not steal Escape from other surfaces.
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOverlayOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible, setSearchOverlayOpen])

  // Focus trap — keeps Tab/Shift+Tab inside the card
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !cardRef.current) return
      const focusable = Array.from(cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.closest('[style*="display: none"]') && el.offsetParent !== null,
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible])

  const trimmed = query.trim()

  const handleSelect = (id: string) => {
    updateActiveTab({ selectedEntryId: id, activeView: 'entries' })
    setSearchOverlayOpen(false)
  }

  const handleScrimClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) setSearchOverlayOpen(false)
  }

  if (!visible) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('search.overlay_aria')}
      className={`xj-scrim fixed z-50 bg-black/35 backdrop-blur-sm ${hostBox ? 'overflow-hidden rounded-2xl' : ''}`}
      style={hostBox ?? { inset: 0 }}
      onClick={handleScrimClick}
    >
      {/* Card — 640px wide, 90px from top, horizontally centered */}
      <div
        ref={cardRef}
        className={cn(
          'absolute top-22.5 left-1/2 w-160 -translate-x-1/2',
          'bg-elevated rounded-2xl shadow-xl',
          'border-border-default border',
          'flex flex-col overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input row — bigger leading icon, tighter input height */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <span
            className="text-fg-faint flex size-6 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            {isLoading && (trimmed || filtersActive) ? (
              <InlineOrb state="solving" />
            ) : (
              <Search className="size-6" strokeWidth={1.75} />
            )}
          </span>
          <TextInput
            ref={inputRef as React.Ref<HTMLInputElement>}
            type="search"
            aria-label={t('search.input_aria')}
            placeholder={t('search.input_placeholder')}
            value={query}
            onChange={setQuery}
            className="h-9 min-w-0 flex-1 text-base"
          />
        </div>

        {/* Mode toggle — "Search by meaning". Off = keyword (default),
            On = semantic. Disabled when the user hasn't opted into
            semantic search yet; tooltip directs them to AI Settings.
            The persisted default lives in Settings → AI; this toggle
            only flips the per-session mode. */}
        <div className="flex items-center justify-end gap-4 px-5 pb-3">
          <div className="flex items-center gap-1.5">
            <Toggle
              checked={keepResults}
              onChange={onKeepResultsChange}
              label={t('search.toggle_keep_results')}
              ariaLabel={t('search.toggle_keep_results_aria')}
              size="xs"
            />
            <Tooltip content={t('search.toggle_keep_results_help')} multiline placement="top">
              <button
                type="button"
                aria-label={t('search.toggle_keep_results_help')}
                className="text-fg-muted hover:text-fg-secondary inline-flex cursor-help items-center rounded-full outline-none"
              >
                <HelpCircle className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
          {semanticEnabled === false ? (
            <Tooltip content={t('search.tab_meaning_disabled_hint')} placement="top">
              <span className="inline-flex">
                <Toggle
                  checked={false}
                  onChange={() => {}}
                  label={t('search.toggle_meaning')}
                  ariaLabel={t('search.toggle_meaning_aria')}
                  disabled
                  size="xs"
                />
              </span>
            </Tooltip>
          ) : (
            <Toggle
              checked={activeMode === 'meaning'}
              onChange={(next) => setMode(next ? 'meaning' : 'keyword')}
              label={t('search.toggle_meaning')}
              ariaLabel={t('search.toggle_meaning_aria')}
              size="xs"
            />
          )}
        </div>

        {/* Filter row */}
        <div className="px-5 pb-3">
          <SearchFilterRow filters={uiFilters} onChange={setUiFilters} />
        </div>

        {/* Divider */}
        <div className="border-border-default mx-5 border-t" />

        {/* Results area */}
        <div className="max-h-120 overflow-y-auto px-5 py-3">
          {/* Error */}
          {error && (
            <div className="flex items-center justify-center py-6">
              <span className="text-danger-text text-sm">
                {t('search.failed', { message: error })}
              </span>
            </div>
          )}

          {/* Semantic mode + blank query — distinct hint (takes precedence over keyword placeholder) */}
          {!isLoading && !error && !trimmed && activeMode === 'meaning' && (
            <div className="flex flex-col items-center justify-center gap-1 py-6">
              <span className="text-fg-muted text-sm">
                {filtersActive
                  ? t('search.placeholder_hint_meaning_needs_query_with_filters')
                  : t('search.placeholder_hint_meaning_needs_query')}
              </span>
            </div>
          )}

          {/* Keyword mode + blank query + no filters — default placeholder */}
          {!isLoading && !error && !trimmed && activeMode === 'keyword' && !filtersActive && (
            <div className="flex flex-col items-center justify-center gap-1 py-6">
              <span className="text-fg-muted text-sm">{t('search.placeholder_title')}</span>
              <span className="text-fg-muted text-xs">{t('search.placeholder_hint')}</span>
            </div>
          )}

          {/* No-results — keyword; filter-specific copy when query is blank */}
          {!isLoading &&
            !error &&
            (trimmed || filtersActive) &&
            resultCount === 0 &&
            activeMode === 'keyword' && (
              <div className="flex items-center justify-center py-6">
                <span className="text-fg-muted text-sm">
                  {trimmed
                    ? t('search.empty_keyword', { query: trimmed })
                    : t('search.empty_filtered_no_query')}
                </span>
              </div>
            )}

          {/* No-results — semantic */}
          {!isLoading && !error && trimmed && resultCount === 0 && activeMode === 'meaning' && (
            <div className="flex items-center justify-center py-6">
              <span className="text-fg-muted text-sm">{t('search.empty')}</span>
            </div>
          )}

          {/* Results list */}
          {resultCount > 0 && (
            <>
              <p className="text-fg-muted mb-2 text-xs font-medium tracking-wider uppercase">
                {t('search.result_count', { count: resultCount })}
              </p>
              {/* Result rows mirror the EntryCard hover style — neutral
                  border that shifts to accent on hover, no card-lift. Keeps
                  the search overlay visually consistent with the entry
                  list users already navigate every day. */}
              <ul className="flex flex-col gap-2" aria-label={t('search.results_aria')}>
                {activeMode === 'keyword'
                  ? keywordSearch.results.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => handleSelect(r.id)}
                          className={cn(
                            'group bg-elevated rounded-md',
                            'border-border-default hover:border-border-default hover:bg-surface-hi border',
                            'w-full px-3.5 py-3 text-left',
                            'cursor-pointer transition-colors duration-200',
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-display text-fg truncate text-sm font-bold">
                              {r.title ?? 'Untitled'}
                            </span>
                            <span className="text-fg-faint shrink-0 font-mono text-xs">
                              {formatEntryDate(r.entry_date)}
                            </span>
                          </div>
                          {r.preview_text && (
                            <p className="text-fg-secondary mt-1 line-clamp-2 text-sm">
                              {highlightQuery(r.preview_text, trimmed)}
                            </p>
                          )}
                        </button>
                      </li>
                    ))
                  : meaningSearch.results.map((h) => {
                      const rel = scoreToRelevance(h.score)
                      const tierLabel = t(RELEVANCE_TIER_I18N_KEY[rel.tier])
                      return (
                        <li key={h.entry_id}>
                          <button
                            type="button"
                            onClick={() => handleSelect(h.entry_id)}
                            className={cn(
                              'group bg-elevated rounded-md',
                              'border-border-default hover:border-border-default hover:bg-surface-hi border',
                              'w-full px-3.5 py-3 text-left',
                              'cursor-pointer transition-colors duration-200',
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-display text-fg truncate text-sm font-bold">
                                {h.title ?? 'Untitled'}
                              </span>
                              <div className="flex shrink-0 items-center gap-2 text-xs">
                                <Tooltip content={tierLabel} placement="top">
                                  <span
                                    className={cn(
                                      'rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
                                      RELEVANCE_TIER_CLASSES[rel.tier],
                                    )}
                                    aria-label={`${tierLabel} — ${rel.percent}%`}
                                  >
                                    {t('search.relevance_label', { percent: rel.percent })}
                                  </span>
                                </Tooltip>
                                <span className="text-fg-faint font-mono">
                                  {formatEntryDate(h.entry_date)}
                                </span>
                              </div>
                            </div>
                            {h.snippet && (
                              <p className="text-fg-secondary mt-1 line-clamp-2 text-sm">
                                {h.snippet}
                              </p>
                            )}
                          </button>
                        </li>
                      )
                    })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
