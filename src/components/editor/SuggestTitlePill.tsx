import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { useSmartSummary } from '../../hooks/useSmartSummary'
import { useAiTitleSuggestionsEnabled } from '../../hooks/useAiTitleSuggestionsEnabled'
import { AiIcon } from '../common/AiIcon'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { toast } from '../../lib/toast'

/// Minimum body character count before the pill renders. Short entries
/// don't carry enough signal for the LLM to produce a meaningful title.
const MIN_CHARS_FOR_SUGGESTION = 200

interface SuggestTitlePillProps {
  /** Entry ID to suggest a title for. When `null` the pill never renders. */
  entryId: string | null
  /** Length of the entry's `content_text`. Drives the
   * [`MIN_CHARS_FOR_SUGGESTION`] gate. */
  bodyCharCount: number
  /** Current title input value. The pill only renders when empty —
   * users with an existing title aren't asked to overwrite it. */
  currentTitle: string
  /** Callback invoked with the final title when the user clicks Apply. */
  onTitleSuggested: (title: string) => void
}

/**
 * "✨ Suggest title" pill (Phase 6 v2 R6 — streaming).
 *
 * Click → backend `suggest_title` IPC starts a streaming chat
 * completion → tokens arrive via `ai:suggest-title-token` events and
 * render inline as they accumulate. Once `ai:suggest-title-complete`
 * lands, the pill expands to show ✓ Apply / ✗ Dismiss buttons. Esc
 * cancels mid-stream and partial text disappears.
 *
 * The hook (`useSmartSummary`) handles the lifecycle; this component
 * just renders the right affordance per `state.kind`.
 */
export function SuggestTitlePill({
  entryId,
  bodyCharCount,
  currentTitle,
  onTitleSuggested,
}: SuggestTitlePillProps) {
  const { t } = useTranslation('ai')
  const aiEnabled = useAiTitleSuggestionsEnabled()
  const { state, suggest, cancel, reset } = useSmartSummary()

  const shouldRender =
    aiEnabled === true &&
    entryId !== null &&
    currentTitle.trim().length === 0 &&
    bodyCharCount >= MIN_CHARS_FOR_SUGGESTION

  // Esc cancels an in-flight stream. Listen at the document level so the
  // user doesn't have to focus the pill first — but bail when the Esc
  // event is targeted at an editable surface so we don't fight modals
  // / inputs / the editor's own command palette for the keystroke.
  useEffect(() => {
    if (state.kind !== 'streaming') return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
          return
        }
      }
      void cancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [state.kind, cancel])

  // Surface fatal errors via toast and reset state so the pill is
  // clickable again. Auth/RateLimited/network errors get user-facing
  // copy; unknown codes fall through to the generic message.
  useEffect(() => {
    if (state.kind !== 'error') return
    const knownCodes: Record<string, string> = {
      AI_AUTH_FAILED: 'error.AI_AUTH_FAILED',
      AI_RATE_LIMITED: 'error.AI_RATE_LIMITED',
      AI_NOT_CONFIGURED: 'error.AI_NOT_CONFIGURED',
      AI_PRIVACY_NOT_ACCEPTED: 'error.AI_PRIVACY_NOT_ACCEPTED',
      AI_PROVIDER_ERROR: 'summary.error_unknown',
      AI_EMPTY_RESPONSE: 'summary.error_unknown',
      AI_PROVIDER_UNSUPPORTED: 'summary.error_unknown',
    }
    const messageKey = knownCodes[state.code] ?? 'summary.error_unknown'
    toast(t(messageKey))
    reset()
  }, [state, t, reset])

  if (!shouldRender) return null

  function handleStart() {
    if (!entryId) return
    void suggest(entryId)
  }

  function handleApply() {
    if (state.kind !== 'done') return
    onTitleSuggested(state.title)
    reset()
  }

  function handleDismiss() {
    // Only call cancel() when there's actually a stream to cancel —
    // in `done` state the backend slot is already gone.
    if (state.kind === 'streaming') {
      void cancel()
    }
    reset()
  }

  if (state.kind === 'idle' || state.kind === 'cancelled' || state.kind === 'error') {
    const label = t('summary.suggest_title')
    return (
      <Tooltip content={label} placement="bottom">
        <button
          type="button"
          onClick={handleStart}
          aria-label={label}
          className="text-fg-muted hover:bg-accent-soft hover:text-fg inline-flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors"
        >
          <AiIcon aria-hidden />
        </button>
      </Tooltip>
    )
  }

  if (state.kind === 'streaming') {
    return (
      <div className="border-border-default bg-panel-1 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
        <InlineOrb state="searching" aria-hidden />
        <ShimmerText className="text-fg-secondary text-sm">{t('summary.suggesting')}</ShimmerText>
        {state.partial && <span className="text-fg max-w-[24em] truncate">{state.partial}</span>}
        <button
          type="button"
          onClick={() => void cancel()}
          className="text-fg-secondary hover:text-fg ml-1 text-xs underline"
          aria-label={t('summary.dismiss')}
        >
          Esc
        </button>
      </div>
    )
  }

  // state.kind === 'done'
  const applyLabel = t('summary.apply')
  const dismissLabel = t('summary.dismiss')
  return (
    <div className="border-border-default bg-panel-1 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
      <AiIcon className="shrink-0" aria-hidden />
      <span className="text-fg max-w-[24em] truncate">{state.title}</span>
      <div className="flex items-center">
        <Tooltip content={applyLabel}>
          <button
            type="button"
            onClick={handleApply}
            aria-label={applyLabel}
            className="text-success-text hover:text-fg inline-flex size-6 cursor-pointer items-center justify-center rounded-full"
          >
            <Check className="size-4" aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content={dismissLabel}>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={dismissLabel}
            className="text-fg-secondary hover:text-fg inline-flex size-6 cursor-pointer items-center justify-center rounded-full"
          >
            <X className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
