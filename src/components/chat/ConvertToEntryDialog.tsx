import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { JournalScopePicker } from '../journals/JournalScopePicker'
import { extractAiErrorCode } from '../../lib/aiErrorCode'
import { announce } from '../../stores/announcerStore'
import { renderSimpleMarkdown } from '../../lib/simpleMarkdown'
import { useJournalStore } from '../../stores/journalStore'

interface ConvertToEntryDialogProps {
  /** Resolves with the drafted markdown returned by
   *  `convert_chat_to_entry`. The caller is responsible for invoking
   *  the IPC and handing the result here — this dialog just renders
   *  the modal and lets the user accept / edit / cancel. */
  loadDraft: () => Promise<string>
  /** Called with the final markdown and the journal the user picked when
   *  they click Save. The parent owns entry-creation (so it can navigate
   *  to the new entry's editor on success). */
  onSave: (markdown: string, journalId: string) => Promise<void>
  /** Called when the user clicks Cancel or hits Escape. */
  onCancel: () => void
  /** Overrides the modal title. Defaults to the save-mode title
   *  (`convert_modal.title`). The update path passes
   *  `convert_modal.update_title`. */
  title?: string
  /** Overrides the confirm-button label. Defaults to the save-mode label
   *  (`convert_modal.save`). The update path passes
   *  `convert_modal.update_save`. */
  saveLabel?: string
  /** Whether to render the journal picker. Defaults to `true` (save mode).
   *  When `false` (update mode), the dialog skips the picker entirely —
   *  the entry already belongs to a journal, so `onSave` is still invoked
   *  but the update handler ignores `journalId` and appends to the
   *  existing converted entry instead of re-filing it. */
  showJournalPicker?: boolean
}

type DraftState =
  | { kind: 'loading' }
  | { kind: 'editing'; markdown: string }
  | { kind: 'error'; code: string }
  | { kind: 'saving'; markdown: string }

/**
 * Convert-to-Entry modal (Phase 6 v2 R9).
 *
 * Opens with a spinner, awaits the convert IPC, then renders the
 * drafted markdown in an editable textarea + side-by-side preview.
 * Save → calls `onSave(markdown)`; the parent creates the entry via
 * the existing `create_entry` + `save_entry_content` pipeline and
 * navigates the user to it.
 *
 * The chat buffer that produced the draft stays in memory in the
 * parent's `useDailyChat` hook — we never persist it.
 */
export function ConvertToEntryDialog({
  loadDraft,
  onSave,
  onCancel,
  title,
  saveLabel,
  showJournalPicker = true,
}: ConvertToEntryDialogProps) {
  const { t } = useTranslation('ai')
  const [state, setState] = useState<DraftState>({ kind: 'loading' })
  const [showPreview, setShowPreview] = useState(true)

  // Journals come from the store already populated + invisible-filtered by the
  // always-mounted Sidebar's `useJournals()` (same source EntryList reads).
  const journals = useJournalStore((s) => s.journals)
  // Default to the first journal. Lazy init so a mid-modal store update can't
  // clobber the user's pick. The Sidebar's always-mounted `useJournals()`
  // populates the store before this dialog can open (and onboarding guarantees
  // ≥1 journal), so the list is ready at mount.
  const [journalId, setJournalId] = useState<string>(() => journals[0]?.id ?? '')

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    setState({ kind: 'loading' })
    announce(t('announcer.generating'))
    loadDraft()
      .then((markdown) => {
        if (cancelled) return
        setState({ kind: 'editing', markdown })
        announce(t('announcer.done'))
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({ kind: 'error', code: extractAiErrorCode(e) ?? 'AI_UNKNOWN_ERROR' })
      })
    return () => {
      cancelled = true
    }
  }, [loadDraft, t])

  async function handleSave() {
    // `journalId` is only required when the picker is shown (save mode).
    // In update mode the entry already belongs to a journal, the picker is
    // hidden, and the parent ignores `journalId` — so the empty-string
    // default must not block the save.
    if (state.kind !== 'editing') return
    if (showJournalPicker && !journalId) return
    setState({ kind: 'saving', markdown: state.markdown })
    try {
      await onSave(state.markdown, journalId)
      // Parent unmounts the dialog on success; nothing else to do.
    } catch (e: unknown) {
      setState({ kind: 'error', code: extractAiErrorCode(e) ?? 'AI_UNKNOWN_ERROR' })
    }
  }

  return (
    <Modal onClose={onCancel} maxWidth={760}>
      <Modal.Header
        id="convert-to-entry-title"
        description={
          state.kind === 'editing' || state.kind === 'saving'
            ? t('daily_chat.convert_modal.hint', {
                defaultValue:
                  'Review the draft below. You can edit it before saving — the conversation itself will not be kept.',
              })
            : undefined
        }
      >
        {title ?? t('daily_chat.convert_modal.title', { defaultValue: 'Save as journal entry' })}
      </Modal.Header>
      <Modal.Body>
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center gap-3 py-12">
            <InlineOrb state="searching" aria-hidden />
            <ShimmerText className="text-fg-secondary text-sm">
              {t('daily_chat.convert_modal.loading', {
                defaultValue: 'Drafting your entry…',
              })}
            </ShimmerText>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="py-6">
            <p className="text-danger-text text-sm">
              {t('daily_chat.convert_modal.error', {
                defaultValue: "Couldn't draft an entry from the conversation.",
              })}
            </p>
            <p className="text-fg-secondary mt-2 font-mono text-xs">{state.code}</p>
          </div>
        )}
        {(state.kind === 'editing' || state.kind === 'saving') && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-fg-secondary text-xs font-medium">
                {showPreview
                  ? t('daily_chat.convert_modal.split_label', { defaultValue: 'Edit + preview' })
                  : t('daily_chat.convert_modal.edit_label', { defaultValue: 'Edit' })}
              </label>
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="text-accent-text hover:text-accent text-xs underline"
              >
                {showPreview
                  ? t('daily_chat.convert_modal.hide_preview', {
                      defaultValue: 'Hide preview',
                    })
                  : t('daily_chat.convert_modal.show_preview', {
                      defaultValue: 'Show preview',
                    })}
              </button>
            </div>
            <div
              className={
                showPreview ? 'grid grid-cols-1 gap-3 sm:grid-cols-2' : 'grid grid-cols-1 gap-3'
              }
            >
              <textarea
                value={state.markdown}
                onChange={(e) => setState({ kind: 'editing', markdown: e.target.value })}
                disabled={state.kind === 'saving'}
                rows={16}
                className="border-border-default bg-panel-1 text-fg w-full rounded-lg border px-3 py-2 font-mono text-sm focus:outline-none"
                aria-label={t('daily_chat.convert_modal.edit_label', {
                  defaultValue: 'Edit',
                })}
              />
              {showPreview && (
                <div
                  className="border-border-default bg-panel-1 text-fg max-h-[24em] space-y-3 overflow-y-auto rounded-lg border px-3 py-2 text-sm"
                  aria-label="preview"
                >
                  {renderSimpleMarkdown(state.markdown)}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer className="items-center">
        {showJournalPicker && (state.kind === 'editing' || state.kind === 'saving') && (
          // Same circle-icon picker as the entry-list journal filter, used here
          // as a target selector (no "All journals" option — a concrete journal
          // must be picked).
          <JournalScopePicker
            journalId={journalId || null}
            journals={journals}
            onChange={(id) => setJournalId(id ?? '')}
            allowAll={false}
            showLabel
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={state.kind === 'saving'}>
            {t('daily_chat.convert_modal.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={state.kind === 'saving'}
            loadingError={state.kind === 'error'}
            announceOnSettle={t('announcer.entry_saved')}
            onClick={handleSave}
            disabled={
              state.kind !== 'editing' ||
              !state.markdown.trim() ||
              (showJournalPicker && !journalId)
            }
          >
            {state.kind === 'saving'
              ? t('daily_chat.convert_modal.saving', { defaultValue: 'Saving…' })
              : (saveLabel ?? t('daily_chat.convert_modal.save', { defaultValue: 'Save entry' }))}
          </Button>
        </div>
      </Modal.Footer>
    </Modal>
  )
}
