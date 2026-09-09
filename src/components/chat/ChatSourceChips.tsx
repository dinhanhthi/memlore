import { useId, useState } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { useTranslation } from 'react-i18next'
import { BookOpenText, FileText } from 'lucide-react'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { useEntryTitles } from '../../hooks/useEntryTitles'
import { truncateText } from '../../lib/truncateText'
import { capList } from '../../lib/capList'

const SOURCE_CHIP_TITLE_MAX = 24
// Sources are a privacy disclosure — which journal entries reached the AI
// provider for this reply. Capped for readability, but the true total is
// always shown alongside the capped list so truncation never understates
// what actually left the machine.
const MAX_SOURCES_SHOWN = 10

export interface ChatSourceChipsProps {
  /** `ChatMessage.sourceEntryIds` — entry ids whose content actually
   *  reached the prompt for this assistant turn. */
  sourceEntryIds: string[]
  onOpenEntry: (entryId: string) => void
}

/**
 * Book trigger (icon + source count) and a floating popover listing the
 * source entries an
 * assistant reply drew on — sits in the message meta row next to
 * `MessageInfoPopover`, following the same floating-ui setup (`fixed`
 * strategy + portal to escape the transcript's `overflow-y-auto`).
 */
export function ChatSourceChips({ sourceEntryIds, onOpenEntry }: ChatSourceChipsProps) {
  const { t } = useTranslation(['ai', 'editor'])
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const { shown, total, truncated } = capList(sourceEntryIds, MAX_SOURCES_SHOWN)
  const { titles } = useEntryTitles(shown)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    // fixed + portal: avoid clipping inside ChatConversation's overflow-y-auto
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  if (total === 0) return null

  const tooltip = t('daily_chat.sources_trigger_tooltip', { defaultValue: 'Sources' })

  return (
    <div className="inline-flex">
      <Tooltip content={tooltip}>
        <Button
          ref={refs.setReference}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('daily_chat.sources_trigger_aria', {
            count: total,
            defaultValue: '{{count}} sources used for this reply',
          })}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="text-fg-muted hover:text-fg h-6 gap-1 px-1.5"
          {...getReferenceProps()}
        >
          <BookOpenText className="size-3.5" aria-hidden />
          {/* `total`, never `shown.length` — the badge reports how many
              entries reached the provider, which is the disclosure. Showing
              the capped count would understate it by exactly the amount the
              popover's "Showing 10 of N" line exists to correct. */}
          <span className="text-2xs font-medium tabular-nums" aria-hidden>
            {total}
          </span>
        </Button>
      </Tooltip>

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              aria-labelledby={labelId}
              // `overflow-hidden` is load-bearing, not cosmetic: without a
              // paint clip on the rounded box, WebKit lets the inner scroll
              // container's composited layer draw chips outside the panel's
              // border while the list is being scrolled.
              className="border-border-default bg-elevated z-(--z-tooltip) w-72 overflow-hidden rounded-lg border p-3 shadow-(--elev-3)"
            >
              <p id={labelId} className="text-fg mb-1 text-xs font-medium">
                {t('daily_chat.sources_heading', {
                  count: total,
                  defaultValue: '{{count}} sources',
                })}
              </p>
              {truncated && (
                <p className="text-fg-muted text-2xs mb-2">
                  {t('daily_chat.sources_truncated_hint', {
                    shown: shown.length,
                    total,
                    defaultValue: 'Showing {{shown}} of {{total}}',
                  })}
                </p>
              )}
              {/* `overscroll-contain`: reaching the end of this list must not
                  chain the scroll to the transcript underneath. The popover is
                  `strategy: 'fixed'` under `autoUpdate`, so scrolling the
                  transcript moves its anchor and drags the panel mid-scroll. */}
              <div className="flex max-h-60 flex-wrap gap-2 overflow-y-auto overscroll-contain">
                {shown.map((entryId) => {
                  const resolved = titles.get(entryId)
                  const fullTitle =
                    resolved === undefined
                      ? entryId
                      : (resolved ?? t('editor:untitled_entry', { defaultValue: 'Untitled' }))
                  const chipTitle = truncateText(fullTitle, SOURCE_CHIP_TITLE_MAX)
                  // Only show the full-title tooltip when the chip text was shortened.
                  const isChipTruncated = fullTitle.trim().length > SOURCE_CHIP_TITLE_MAX

                  return (
                    <Tooltip
                      key={entryId}
                      content={fullTitle}
                      placement="top"
                      disabled={!isChipTruncated}
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<FileText className="size-3.5" aria-hidden />}
                        className="hover:border-accent/50 hover:bg-accent-soft hover:text-accent-text text-fg-secondary max-w-full"
                        // Dismiss the popover as well: `onOpenEntry` now
                        // opens a modal on top of this list instead of
                        // navigating away, so leaving it mounted stacks a
                        // z-(--z-tooltip) floating panel over the dialog.
                        onClick={() => {
                          setOpen(false)
                          onOpenEntry(entryId)
                        }}
                      >
                        {t('daily_chat.source_chip', {
                          defaultValue: 'Entry "{{title}}"',
                          title: chipTitle,
                        })}
                      </Button>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  )
}
