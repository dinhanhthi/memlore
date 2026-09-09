import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { errMsg } from '../../lib/errMsg'
import { toast } from '../../lib/toast'
import {
  downloadGoogleFont,
  getGoogleFontsCatalogMeta,
  refreshGoogleFontsCatalog,
  searchGoogleFontsCatalog,
  type GoogleFontCatalogEntry,
  type GoogleFontCatalogMeta,
} from '../../lib/tauri'
import { Button } from '../common/Button'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { Modal } from '../common/Modal'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { TextInput } from '../common/TextInput'
import { Tooltip } from '../common/Tooltip'

// ─── Constants ────────────────────────────────────────────────────────────────

const API_KEY_MISSING_SENTINEL = 'GOOGLE_FONTS_API_KEY_MISSING'
const SEARCH_LIMIT = 100
/** Debounce window for the auto-search effect — gives the user a beat to
 *  finish typing before we issue a DB query. */
const SEARCH_DEBOUNCE_MS = 250

// ─── Helpers ─────────────────────────────────────────────────────────────────

function googleFontsUrl(family: string): string {
  return `https://fonts.google.com/specimen/${family.replace(/ /g, '+')}`
}

/**
 * Build a variant key from a weight number for looking up in `entry.files`.
 * weight 400 → "regular", weight N → "N".
 */
function variantKeyForWeight(weight: number): string {
  return weight === 400 ? 'regular' : String(weight)
}

/**
 * Derive the list of numeric weights from a catalog entry's variants array.
 * Italic-only variants (e.g. "italic", "700italic") are excluded because the
 * current download path is weight-only.
 */
function weightsFromVariants(variants: string[]): number[] {
  const weights: number[] = []
  for (const v of variants) {
    if (v.toLowerCase().includes('italic')) continue
    if (v === 'regular') {
      weights.push(400)
    } else {
      const n = parseInt(v, 10)
      if (!isNaN(n) && n > 0) weights.push(n)
    }
  }
  // Deduplicate and sort ascending.
  return [...new Set(weights)].sort((a, b) => a - b)
}

/**
 * Format a Unix timestamp (seconds) as a human-readable relative time string
 * using `Intl.RelativeTimeFormat`.
 */
function formatRelativeTime(fetchedAtSec: number): string {
  const diffSec = Math.floor((Date.now() - fetchedAtSec * 1000) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (diffSec < 60) return rtf.format(-diffSec, 'second')
  if (diffSec < 3600) return rtf.format(-Math.floor(diffSec / 60), 'minute')
  if (diffSec < 86400) return rtf.format(-Math.floor(diffSec / 3600), 'hour')
  return rtf.format(-Math.floor(diffSec / 86400), 'day')
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Stage = 'offline' | 'loading-catalog' | 'ready' | 'searching' | 'error'

// ─── Props ────────────────────────────────────────────────────────────────────

interface CustomGoogleFontModalProps {
  onClose: () => void
  /** Called with (familyName, weight, localPath) after a successful download. */
  onConfirm: (familyName: string, weight: number, localPath: string) => void
  /** Currently configured custom font, for pre-selection. */
  currentFamily: string | null
  currentWeight: number | null
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CustomGoogleFontModal({
  onClose,
  onConfirm,
  currentFamily,
  currentWeight,
}: CustomGoogleFontModalProps) {
  const { t } = useTranslation('settings')

  // Stage machine. Start in `loading-catalog` regardless of `navigator.onLine`
  // — that signal is unreliable on macOS and would spuriously gate the modal.
  // We always try a DB read first (works offline) and only fall back to
  // `offline` if the network refresh actually fails AND we have no cache.
  const [stage, setStage] = useState<Stage>('loading-catalog')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Catalog meta (for the "last updated" footer)
  const [meta, setMeta] = useState<GoogleFontCatalogMeta | null>(null)

  // Search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GoogleFontCatalogEntry[]>([])
  const [lastSearchedQuery, setLastSearchedQuery] = useState<string | null>(null)

  // Selection
  const [selectedEntry, setSelectedEntry] = useState<GoogleFontCatalogEntry | null>(null)
  const [selectedWeight, setSelectedWeight] = useState<number | null>(null)

  // Download
  const [busy, setBusy] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // Refresh
  const [refreshing, setRefreshing] = useState(false)

  // Ref to track if we're mounted (avoid setState after unmount during async ops).
  // React 18 StrictMode dev-mounts effects twice: setup → cleanup → setup. The
  // setup re-runs `mountedRef.current = true` so an in-flight promise survives
  // the simulated unmount and resolves into the still-live second mount.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Monotonic request id — used to discard stale search/refresh responses if
  // the user issues a newer request before an earlier one returns. Without
  // this, the slower (earlier) response would overwrite the newer one.
  const reqIdRef = useRef(0)

  // One-shot guard for the initial catalog load. The `online` event can fire
  // multiple times during WiFi handoff; without this, each fire would queue
  // another refresh behind the DB mutex.
  const initialLoadStartedRef = useRef(false)

  // ── doRefresh: fetch catalog from API ─────────────────────────────────────
  const doRefresh = useCallback(
    async (showSpinner: boolean) => {
      const myId = ++reqIdRef.current
      if (showSpinner) setRefreshing(true)
      try {
        const newMeta = await refreshGoogleFontsCatalog()
        if (!mountedRef.current || myId !== reqIdRef.current) return
        setMeta(newMeta)
        setStage('ready')
        // Re-run the current search if one was active — same id, so a newer
        // user-initiated search will still preempt this trailing re-search.
        if (lastSearchedQuery !== null && lastSearchedQuery.trim().length > 0) {
          const newResults = await searchGoogleFontsCatalog(lastSearchedQuery, SEARCH_LIMIT)
          if (!mountedRef.current || myId !== reqIdRef.current) return
          setResults(newResults)
        }
      } catch (e) {
        if (!mountedRef.current || myId !== reqIdRef.current) return
        const msg = errMsg(e)
        if (msg === API_KEY_MISSING_SENTINEL) {
          setStage('error')
          setErrorMessage(t('editor.font.custom_modal.api_key_missing'))
        } else if (stage === 'loading-catalog') {
          // Initial load failed and there's no cache — switch to offline
          // state so the user gets a single clear "needs internet" screen
          // instead of a generic error.
          setStage('offline')
        } else {
          toast(t('editor.font.custom_modal.refresh_failed'))
        }
      } finally {
        if (mountedRef.current && myId === reqIdRef.current) {
          setRefreshing(false)
        }
      }
    },
    [lastSearchedQuery, stage, t],
  )

  // ── Initial catalog load (one-shot) ────────────────────────────────────────
  // Runs on mount only. Reads SQLite meta — if we have a cached catalog, go
  // straight to `ready`. Otherwise, attempt a network refresh; failure here
  // surfaces the offline screen because the modal is unusable without data.
  //
  // We intentionally gate purely on `mountedRef` (not a per-effect `cancelled`
  // flag): React 18 StrictMode mounts effects twice in dev, and a local
  // `cancelled = true` set by the first cleanup would short-circuit the
  // `loadInitial` promise even though the component is still mounted, leaving
  // the modal stuck on the loading spinner. `initialLoadStartedRef` ensures
  // the second mount skips the fetch entirely.
  useEffect(() => {
    if (initialLoadStartedRef.current) return
    initialLoadStartedRef.current = true

    async function loadInitial() {
      try {
        const m = await getGoogleFontsCatalogMeta()
        if (!mountedRef.current) return
        setMeta(m)
        if (m.fetchedAt === null) {
          await doRefresh(false)
        } else {
          setStage('ready')
        }
      } catch {
        if (!mountedRef.current) return
        setStage('error')
        setErrorMessage(t('editor.font.custom_modal.refresh_failed'))
      }
    }
    void loadInitial()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Online event — recover from offline state ──────────────────────────────
  // Only listens for `online` (not `offline`): once we're in the offline
  // stage, recovering connectivity should let the user retry by triggering
  // a fresh refresh. We do NOT switch to `offline` on the `offline` event
  // mid-session — `navigator.onLine` is unreliable enough that doing so
  // would cause spurious modal interruptions during temporary network blips.
  useEffect(() => {
    function handleOnline() {
      if (stage === 'offline' && !refreshing) {
        setStage('loading-catalog')
        void doRefresh(false)
      }
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [stage, refreshing, doRefresh])

  // ── Search ─────────────────────────────────────────────────────────────────
  // Auto-search runs whenever `query` changes, debounced by SEARCH_DEBOUNCE_MS
  // so rapid typing doesn't hit the DB on every keystroke. Each scheduled run
  // bumps `reqIdRef` so a slower earlier response never overwrites the latest.
  const runSearch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim()
      const myId = ++reqIdRef.current
      setLastSearchedQuery(trimmed)
      if (!trimmed) {
        setResults([])
        setStage('ready')
        return
      }
      setStage('searching')
      try {
        const hits = await searchGoogleFontsCatalog(trimmed, SEARCH_LIMIT)
        if (!mountedRef.current || myId !== reqIdRef.current) return
        setResults(hits)
        setStage('ready')
      } catch {
        if (!mountedRef.current || myId !== reqIdRef.current) return
        setStage('ready')
        toast(t('editor.font.custom_modal.refresh_failed'))
      }
    },
    [t],
  )

  useEffect(() => {
    // Skip until the catalog is ready — we'd just spam DB reads against an
    // empty table during the initial load.
    if (stage === 'loading-catalog' || stage === 'offline' || stage === 'error') return
    const handle = window.setTimeout(() => {
      void runSearch(query)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query, stage, runSearch])

  // ── Font selection ─────────────────────────────────────────────────────────
  function handleSelectEntry(entry: GoogleFontCatalogEntry) {
    setSelectedEntry(entry)
    const weights = weightsFromVariants(entry.variants)
    const fallback = weights[0] ?? 400
    // Keep the current weight if it's valid for this font, otherwise snap to
    // the first available weight.
    if (
      currentFamily === entry.family &&
      currentWeight !== null &&
      weights.includes(currentWeight)
    ) {
      setSelectedWeight(currentWeight)
    } else if (weights.includes(400)) {
      setSelectedWeight(400)
    } else {
      setSelectedWeight(fallback)
    }
    setDownloadError(null)
  }

  // ── Apply (download) ───────────────────────────────────────────────────────
  async function handleApply() {
    if (!selectedEntry || selectedWeight === null) return
    const variantKey = variantKeyForWeight(selectedWeight)
    const fileUrl = selectedEntry.files[variantKey]
    setBusy(true)
    setDownloadError(null)
    try {
      const result = await downloadGoogleFont(selectedEntry.family, selectedWeight, fileUrl)
      onConfirm(result.family, result.weight, result.localPath)
      onClose()
    } catch (e) {
      const message = errMsg(e)
      const friendly = t('editor.font.custom_modal.download_error')
      setDownloadError(friendly)
      toast(`${friendly} — ${message}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const canApply = selectedEntry !== null && selectedWeight !== null && !busy && !refreshing

  // ── Render ─────────────────────────────────────────────────────────────────

  // Offline screen
  if (stage === 'offline') {
    return (
      <Modal onClose={onClose} maxWidth={480}>
        <Modal.Header description={t('editor.font.custom_modal.offline_error')}>
          {t('editor.font.custom_modal.title')}
        </Modal.Header>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('editor.font.custom_modal.offline_close')}
          </Button>
        </Modal.Footer>
      </Modal>
    )
  }

  // Error screen (fatal: API key missing, network error on initial load)
  if (stage === 'error') {
    return (
      <Modal onClose={onClose} maxWidth={480}>
        <Modal.Header description={errorMessage}>
          {t('editor.font.custom_modal.title')}
        </Modal.Header>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('editor.font.custom_modal.cancel')}
          </Button>
        </Modal.Footer>
      </Modal>
    )
  }

  // Loading catalog screen
  if (stage === 'loading-catalog') {
    return (
      <Modal onClose={onClose} maxWidth={720}>
        <Modal.Header>{t('editor.font.custom_modal.title')}</Modal.Header>
        <Modal.Body>
          <div
            className="text-fg-muted flex items-center gap-2 text-sm"
            role="status"
            aria-live="polite"
          >
            <InlineOrb state="searching" aria-hidden />
            <ShimmerText className="text-sm">
              {t('editor.font.custom_modal.loading_catalog')}
            </ShimmerText>
          </div>
        </Modal.Body>
      </Modal>
    )
  }

  // Ready / searching screens — full modal
  const isSearching = stage === 'searching'
  const showResults = lastSearchedQuery !== null && lastSearchedQuery.trim().length > 0
  const hasResults = results.length > 0

  return (
    <Modal onClose={busy ? () => {} : onClose} maxWidth={720} disableEsc={busy}>
      <Modal.Header>{t('editor.font.custom_modal.title')}</Modal.Header>
      <Modal.Body>
        <div className="flex flex-col gap-4">
          {/* Search input — auto-searches as you type, debounced */}
          <div className="relative">
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder={t('editor.font.custom_modal.search_placeholder')}
              aria-label={t('editor.font.custom_modal.search_placeholder')}
              disabled={busy}
              autoFocus
            />
            {isSearching && (
              <span
                className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center"
                aria-hidden="true"
              >
                <InlineOrb state="solving" />
              </span>
            )}
          </div>

          {/* Results list */}
          <div
            role="listbox"
            aria-label={t('editor.font.custom_modal.title')}
            className="border-border-default max-h-[40vh] min-h-30 overflow-y-auto rounded-xl border"
          >
            {!showResults ? (
              <p className="text-fg-muted p-4 text-center text-sm">
                {t('editor.font.custom_modal.empty_query_hint')}
              </p>
            ) : !hasResults ? (
              <p className="text-fg-muted p-4 text-center text-sm">
                {t('editor.font.custom_modal.no_results', {
                  query: lastSearchedQuery,
                })}
              </p>
            ) : (
              <ul className="flex flex-col">
                {results.map((entry) => {
                  const isSelected = selectedEntry?.family === entry.family
                  const previewUrl = googleFontsUrl(entry.family)
                  return (
                    <li
                      key={entry.family}
                      className={
                        'flex items-stretch ' +
                        (isSelected ? 'bg-accent-soft' : 'hover:bg-accent-soft/40')
                      }
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleSelectEntry(entry)}
                        disabled={busy}
                        className={
                          'flex flex-1 items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors ' +
                          (isSelected ? 'text-accent-text font-semibold' : 'text-fg')
                        }
                      >
                        <span>{entry.family}</span>
                        <span className="text-fg-muted text-xs">{entry.category}</span>
                      </button>
                      <Tooltip
                        content={t('editor.font.custom_modal.preview_on_google', {
                          name: entry.family,
                        })}
                      >
                        <a
                          href={previewUrl}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void openUrl(previewUrl)
                          }}
                          aria-label={t('editor.font.custom_modal.preview_on_google', {
                            name: entry.family,
                          })}
                          className="text-fg-muted hover:text-accent-text flex items-center justify-center px-3 transition-colors focus:outline-none"
                          tabIndex={busy ? -1 : 0}
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      </Tooltip>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Weight picker (shown when a font is selected) */}
          {selectedEntry !== null && (
            <div className="flex flex-col gap-2">
              <span className="text-fg text-sm font-medium">
                {t('editor.font.custom_modal.weight_label')}
              </span>
              <div
                role="radiogroup"
                aria-label={t('editor.font.custom_modal.weight_label')}
                className="flex flex-wrap gap-2"
              >
                {weightsFromVariants(selectedEntry.variants).map((w) => (
                  <RadioOptionPill
                    key={w}
                    selected={selectedWeight === w}
                    onClick={() => setSelectedWeight(w)}
                    disabled={busy}
                    className="px-3 py-1 text-xs tabular-nums"
                    label={w}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Download error */}
          {downloadError && (
            <p role="alert" className="text-danger-text text-sm">
              {downloadError}
            </p>
          )}

          {/* Catalog footer */}
          <div className="text-fg-muted flex items-center gap-1 text-xs">
            {meta?.fetchedAt !== undefined && meta.fetchedAt !== null ? (
              <>
                <span>
                  {t('editor.font.custom_modal.catalog_last_updated', {
                    time: formatRelativeTime(meta.fetchedAt),
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => void doRefresh(true)}
                  disabled={refreshing || busy}
                  className="text-accent-text hover:underline disabled:opacity-50"
                >
                  {refreshing
                    ? t('editor.font.custom_modal.refreshing')
                    : t('editor.font.custom_modal.refresh_link')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void doRefresh(true)}
                disabled={refreshing || busy}
                className="text-accent-text hover:underline disabled:opacity-50"
              >
                {refreshing
                  ? t('editor.font.custom_modal.refreshing')
                  : t('editor.font.custom_modal.refresh_link')}
              </button>
            )}
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t('editor.font.custom_modal.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleApply()}
          loading={busy}
          disabled={!canApply && !busy}
        >
          {busy ? t('editor.font.custom_modal.downloading') : t('editor.font.custom_modal.apply')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
