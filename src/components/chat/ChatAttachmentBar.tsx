import { CalendarRange, FileText, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDateRange } from '../../lib/dates'
import type { ChatAttachment, ChatContextPreflight, ChatContextRefusal } from '../../types/ai'

export interface ChatAttachmentBarProps {
  attachments: ChatAttachment[]
  onRemove: (index: number) => void
  /** Display-only context-size estimate from `useChatContextPreflight` (T5.3).
   *  Never a gate — the bar only shows what it is told. */
  preflight: ChatContextPreflight | null
  /** The last rejected send's refusal, owned by `ChatConversation` (T5.8).
   *  When present it replaces the size readout — the bar never decides
   *  anything itself, it only surfaces the backend's decision. */
  refusal?: ChatContextRefusal | null
}

type TFn = ReturnType<typeof useTranslation<['ai', 'editor']>>['t']

/** Display label for a chip. For periods, re-derive from `start`/`end`
 *  rather than trusting the stored `label`: a synced period's label can
 *  arrive as `sanitize_display_name`'s fallback string ("Synced Journal")
 *  when the peer-supplied original was entirely control/bidi characters,
 *  which reads as nonsense on a date chip. The timestamps are always
 *  trustworthy and deriving from them is cheap. */
function chipLabel(attachment: ChatAttachment, locale: string, t: TFn): string {
  if (attachment.kind === 'entry') {
    return attachment.title ?? t('editor:untitled_entry', { defaultValue: 'Untitled' })
  }
  return formatDateRange(attachment.start, attachment.end, locale) || attachment.label
}

function AttachmentChip({
  attachment,
  locale,
  t,
  onRemove,
}: {
  attachment: ChatAttachment
  locale: string
  t: TFn
  onRemove: () => void
}) {
  const label = chipLabel(attachment, locale, t)

  return (
    <span className="border-border-default bg-panel-2 text-fg-secondary text-2xs inline-flex max-w-50 items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-2.5 font-medium">
      {attachment.kind === 'entry' ? (
        <FileText className="size-3 shrink-0" aria-hidden />
      ) : (
        <CalendarRange className="size-3 shrink-0" aria-hidden />
      )}
      <span className="truncate">{label}</span>
      {attachment.kind === 'period' && (
        <span className="text-fg-muted shrink-0">
          {t('daily_chat.attach_entry_count', {
            count: attachment.entryCount,
            defaultValue: '{{count}} entries',
          })}
        </span>
      )}
      <button
        type="button"
        aria-label={t('daily_chat.attach_remove', {
          label,
          defaultValue: 'Remove "{{label}}"',
        })}
        onClick={onRemove}
        className="text-fg-muted hover:text-fg ml-0.5 flex shrink-0 items-center justify-center rounded-full transition-colors outline-none"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

/** The always-visible context-size readout. Shown whenever an estimate
 *  exists, not only when it is large — the point is that context size is
 *  never silently large, and a number that only shows up when there's a
 *  problem teaches users to ignore it. */
function ContextSizeReadout({ preflight, t }: { preflight: ChatContextPreflight; t: TFn }) {
  const kb = Math.round(preflight.estimatedBytes / 1024)

  if (preflight.needsConfirm) {
    return (
      <span className="text-warning inline-flex shrink-0 items-center gap-1 text-xs font-medium">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {/* "may", not "will": the estimate assumes auto-RAG uses its whole
            remaining allowance, but the backend's intent gate can decide the
            turn needs no journal context at all. Over-estimating is the safe
            direction; promising a trim that does not happen is not. */}
        {t('daily_chat.context_size_trimmed', {
          kb,
          defaultValue: 'up to {{kb}} KB — may be trimmed',
        })}
      </span>
    )
  }

  return (
    <span className="text-fg-muted shrink-0 text-xs font-medium">
      {t('daily_chat.context_size', { kb, defaultValue: 'up to {{kb}} KB' })}
    </span>
  )
}

/** The backend's refusal message for the last rejected send, phrased per
 *  code. Exhaustive `switch` (no `default`) so a future refusal code added
 *  to the `ChatContextRefusal` union fails to compile here instead of
 *  silently rendering nothing. */
function refusalMessage(refusal: ChatContextRefusal, t: TFn): string {
  switch (refusal.code) {
    case 'period_too_large':
      return t('daily_chat.period_too_large', {
        label: refusal.label,
        count: refusal.entryCount,
        defaultValue: '"{{label}}" has {{count}} entries — too many to send in one message.',
      })
    case 'period_no_budget':
      // Not a size problem — other attachments consumed the shared budget
      // before this period's share was ever evaluated. Word it that way.
      return t('daily_chat.period_no_budget', {
        label: refusal.label,
        defaultValue: '"{{label}}" couldn\'t fit — other attachments used up the available space.',
      })
    case 'needs_confirmation':
      return t('daily_chat.needs_confirmation', {
        kb: Math.round(refusal.estimatedBytes / 1024),
        count: refusal.entriesIncluded,
        defaultValue: 'Sending ~{{kb}} KB from {{count}} entries needs confirmation.',
      })
    case 'consent_required':
      return t('daily_chat.consent_required', {
        defaultValue: 'Sending multiple entries needs your consent first.',
      })
  }
}

/**
 * Row rendered directly above the Daily Chat composer whenever the user has
 * attached something: dismissible chips for each attachment, plus an
 * always-visible readout of how much of the journal is about to be sent.
 * Purely a display for state owned elsewhere — attachments (T5.8), the size
 * estimate (T5.3's `useChatContextPreflight`), and any refusal from the last
 * rejected send (T5.8). It never computes or gates anything itself.
 */
export function ChatAttachmentBar({
  attachments,
  onRemove,
  preflight,
  refusal,
}: ChatAttachmentBarProps) {
  const { t, i18n } = useTranslation(['ai', 'editor'])

  // Chips (or a refusal) are the only things worth a bordered row. The size
  // readout alone is NOT: with zero attachments the total is at most
  // `CHAT_RAG_AUTO_MAX_BYTES` (12 KB), which sits below `CHAT_RAG_WARN_BYTES`
  // (16 KB) by an invariant `warn_threshold_is_above_auto_cap` asserts — so a
  // chip-less readout can never be the thing that warns about oversized
  // context, only an empty-looking box. The oversize guarantee lives in the
  // backend gate, not here.
  //
  // A refusal still renders with no chips: `period_no_budget` arrives right
  // after the user removed the chip that caused it.
  if (attachments.length === 0 && !refusal) return null

  return (
    <div className="border-border-default bg-panel-1 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {attachments.map((attachment, index) => (
          <AttachmentChip
            key={index}
            attachment={attachment}
            locale={i18n.language}
            t={t}
            onRemove={() => onRemove(index)}
          />
        ))}
      </div>

      {refusal ? (
        <span className="text-danger-text shrink-0 text-xs font-medium">
          {refusalMessage(refusal, t)}
        </span>
      ) : (
        preflight && <ContextSizeReadout preflight={preflight} t={t} />
      )}
    </div>
  )
}
