/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, X } from 'lucide-react'
import { Button } from '../common/Button'
import { AiIcon } from '../common/AiIcon'
import { Modal } from '../common/Modal'
import { Tooltip } from '../common/Tooltip'
import {
  useMultiEntrySummary,
  type MultiEntrySummaryEntry,
  type MultiEntrySummaryState,
} from '../../hooks/useMultiEntrySummary'
import { useAiMultiEntrySummaryEnabled } from '../../hooks/useAiMultiEntrySummaryEnabled'
import { renderSimpleMarkdown } from '../../lib/simpleMarkdown'

// ─── Public entry type ────────────────────────────────────────────────────────

// Structural alias — matches MultiEntrySummaryEntry exactly so the three
// surfaces can import this type without depending on the hook directly.
export type AiSummaryEntry = MultiEntrySummaryEntry

// ─── Context ──────────────────────────────────────────────────────────────────

interface AiSummaryContextValue {
  state: MultiEntrySummaryState
  request: (entries: MultiEntrySummaryEntry[]) => void
  confirm: (mode: 'truncate' | 'raw') => void
  dismiss: () => void
  entries: AiSummaryEntry[]
  // `true` when the toggle is on, `false` when off, `null` while hydrating.
  // Button and Banner self-gate on this so Root can always render children
  // (the view's entry list must remain visible regardless of AI state).
  enabled: boolean | null
}

const AiSummaryContext = createContext<AiSummaryContextValue | null>(null)

function useAiSummaryContext(): AiSummaryContextValue {
  const ctx = useContext(AiSummaryContext)
  if (!ctx)
    throw new Error('AiSummaryTrigger.Button/Banner must be used inside AiSummaryTrigger.Root')
  return ctx
}

// ─── Root ─────────────────────────────────────────────────────────────────────

interface RootProps {
  entries: AiSummaryEntry[]
  children: ReactNode
}

function Root({ entries, children }: RootProps) {
  const enabled = useAiMultiEntrySummaryEnabled()
  const summary = useMultiEntrySummary()

  // Reset stale state (error / done / pending_confirmation) when the
  // caller swaps the entries set — e.g. Calendar selects a different
  // day, or All Entries refreshes after a new entry is created. Without
  // this, an error from the previous selection lingers on the new one.
  // Joined-id string is a stable cache key that ignores object-identity
  // churn from parents that re-create the array on every render.
  const entriesKey = entries.map((e) => e.id).join(',')
  const { dismiss, state } = summary
  useEffect(() => {
    if (state.kind !== 'idle' && state.kind !== 'loading') {
      dismiss()
    }
    // We intentionally depend only on `entriesKey` — state/dismiss are
    // captured via closure to avoid spurious resets when state itself
    // changes (those state transitions are owned by user actions).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey])

  // Always render `children` — they include the surface's entry list /
  // empty-state UI which must NOT depend on the AI toggle. The Button and
  // Banner read `enabled` from context and render `null` when it isn't true.
  const value = useMemo<AiSummaryContextValue>(
    () => ({ ...summary, entries, enabled }),
    [summary, entries, enabled],
  )

  return (
    <AiSummaryContext.Provider value={value}>
      {children}
      {enabled === true && summary.state.kind === 'pending_confirmation' && (
        <WarningModal
          estimatedBytes={summary.state.estimatedBytes}
          onConfirm={summary.confirm}
          onDismiss={summary.dismiss}
        />
      )}
    </AiSummaryContext.Provider>
  )
}

// ─── Button ───────────────────────────────────────────────────────────────────

interface TriggerButtonProps {
  size?: 'sm' | 'md'
  className?: string
}

function TriggerButton({ size = 'sm', className }: TriggerButtonProps) {
  const { t } = useTranslation('ai')
  const { state, request, entries, enabled } = useAiSummaryContext()
  const handleClick = useCallback(() => request(entries), [request, entries])

  // Self-gate: hidden when the toggle is off or still hydrating so the
  // button never appears in a disabled-flicker state and never appears
  // at all when the user has the feature off.
  if (enabled !== true) return null

  const loading = state.kind === 'loading'
  const disabled = entries.length === 0 || state.kind === 'pending_confirmation'
  const label = loading ? t('multi_summary.loading') : t('multi_summary.button')

  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size={size}
        onClick={handleClick}
        disabled={disabled}
        loading={loading}
        loadingError={state.kind === 'error'}
        announceOnSettle={t('announcer.summary_ready')}
        icon={<Sparkles className="size-3.5" aria-hidden />}
        aria-label={label}
        className={className}
      />
    </Tooltip>
  )
}

// ─── Banner ───────────────────────────────────────────────────────────────────

// Backend errors flow through `AiError::Display` which prepends a class
// prefix (e.g. `AI_PROVIDER_ERROR: AI_NO_ENTRIES_WITH_CONTENT`). We strip
// that prefix and map the inner code to an i18n key. Variants without an
// inner payload (`AI_AUTH_FAILED`, `AI_RATE_LIMITED`, etc.) have no
// `": "` separator and are matched directly.
function normaliseErrorCode(raw: string): string {
  const idx = raw.indexOf(': ')
  return idx >= 0 ? raw.slice(idx + 2).trim() : raw.trim()
}

const ERROR_KEY_BY_CODE: Record<string, string> = {
  AI_NO_ENTRIES: 'multi_summary.errors.no_entries',
  AI_NO_ENTRIES_WITH_CONTENT: 'multi_summary.errors.no_content',
  AI_PAYLOAD_TOO_LARGE: 'multi_summary.errors.payload_too_large',
  AI_MULTI_ENTRY_SUMMARY_DISABLED: 'multi_summary.errors.disabled',
  AI_NOT_CONFIGURED: 'multi_summary.errors.not_configured',
  AI_PRIVACY_NOT_ACCEPTED: 'multi_summary.errors.privacy_not_accepted',
  AI_AUTH_FAILED: 'multi_summary.errors.auth_failed',
  AI_RATE_LIMITED: 'multi_summary.errors.rate_limited',
  AI_EMPTY_RESPONSE: 'multi_summary.errors.empty_response',
}

function Banner() {
  const { t } = useTranslation('ai')
  const { state, dismiss, enabled } = useAiSummaryContext()

  // Self-gate: when AI is off / hydrating we never show banners (no
  // result, no error) — keeps the surface visually identical to the
  // pre-feature state when the user has the toggle off.
  if (enabled !== true) return null

  if (state.kind === 'done') {
    return (
      // White-alpha card, not an accent tint: this sits inside the entry
      // list, whose panel colour differs per surface style, and a custom
      // accent turns `bg-accent-soft` into `accent / 0.14` — a wash too
      // faint to lift off the panel. A white overlay lifts by the same
      // amount on every ladder and keeps accent out of the entry list.
      <article className="border-border-default bg-surface-hi mx-2 my-3 rounded-lg border px-3 py-3 text-sm">
        <header className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <AiIcon aria-hidden />
            <span className="text-fg text-xs font-semibold">{t('multi_summary.banner_label')}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={dismiss}
            aria-label={t('multi_summary.dismiss')}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </header>
        <div className="text-fg-secondary text-sm leading-relaxed">
          {renderSimpleMarkdown(state.markdown)}
        </div>
      </article>
    )
  }

  if (state.kind === 'error') {
    const inner = normaliseErrorCode(state.code)
    const key = ERROR_KEY_BY_CODE[inner] ?? 'multi_summary.errors.unknown'
    return (
      <p className="text-danger-text mb-3 px-3 text-xs" role="alert">
        {t(key)}
      </p>
    )
  }

  return null
}

// ─── Warning modal ────────────────────────────────────────────────────────────

interface WarningModalProps {
  estimatedBytes: number
  onConfirm: (mode: 'truncate' | 'raw') => void
  onDismiss: () => void
}

function WarningModal({ estimatedBytes, onConfirm, onDismiss }: WarningModalProps) {
  const { t } = useTranslation('ai')
  const kb = Math.round(estimatedBytes / 1024)
  return (
    <Modal onClose={onDismiss}>
      <Modal.Header description={t('multi_summary.warning.body', { kb })}>
        {t('multi_summary.warning.title')}
      </Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={() => onConfirm('raw')}>
          {t('multi_summary.warning.send_raw')}
        </Button>
        <Button size="sm" onClick={() => onConfirm('truncate')}>
          {t('multi_summary.warning.truncate')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// ─── Compound export ──────────────────────────────────────────────────────────

export const AiSummaryTrigger = {
  Root,
  Button: TriggerButton,
  Banner,
} as const
