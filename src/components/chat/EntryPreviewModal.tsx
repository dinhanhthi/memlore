import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Extension } from '@tiptap/core'
import { SquarePen } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { InlineOrb } from '../common/ThinkingOrb'
import { ShimmerText } from '../common/ShimmerText'
import { getEntry, getEntryContent } from '../../lib/tauri'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { formatEntryDateWithYear } from '../../lib/dates'
import { snapshotToPmJson } from '../../lib/yjs'
import { buildSharedExtensions } from '../editor/sharedExtensions'
import { ensureMathExtensions } from '../../lib/editorMath'
import { editorContentWrapperClass } from '../../lib/editorLayout'
import { useEditorJustifyEnabled } from '../../hooks/useEditorJustifyEnabled'
import { useEditorTypography } from '../../hooks/useEditorTypography'

type PreviewState =
  | { kind: 'loading' }
  /** Reached for a deleted, locked, or otherwise unreadable entry as well as
   *  a genuine fetch failure — the reader gets the same message either way,
   *  because "this entry is locked" would itself disclose that it exists. */
  | { kind: 'unavailable' }
  | { kind: 'loaded'; title: string | null; entryDate: number; hasBody: boolean }

export interface EntryPreviewModalProps {
  entryId: string
  onClose: () => void
  /** Open this entry in the full editor (All Entries). Provided by the host,
   *  which owns tab navigation; the modal only decides when to ask. */
  onEdit: (entryId: string) => void
}

/**
 * Read-only peek at a single entry, opened from a chat reply's source list
 * or from an `[id=…]` badge the model echoed into its answer.
 *
 * Renders through a non-editable TipTap instance built from
 * `buildSharedExtensions` — the same content schema the live editor uses —
 * so headings, math, tables, media, and inline marks look exactly as they do
 * while writing. `content_text` is deliberately NOT used: it is the flattened
 * FTS index string and would show a wall of unformatted prose.
 *
 * Deliberately a modal rather than a tab switch: both entry points sit inside
 * a conversation, and navigating away to All Entries loses the reader's place
 * in a thread they were mid-way through. The Edit button is the opt-in
 * escape hatch for when they do want the editor.
 */
export function EntryPreviewModal({ entryId, onClose, onEdit }: EntryPreviewModalProps) {
  const { t, i18n } = useTranslation(['ai', 'editor'])
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const justifyEnabled = useEditorJustifyEnabled()
  const typography = useEditorTypography()
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })
  const [mathExtensions, setMathExtensions] = useState<Extension[]>([])

  // Force-load the math schema before parsing, mirroring VersionHistoryModal:
  // an entry containing math nodes fails to parse without it, and the nodes
  // would be silently dropped from the preview.
  useEffect(() => {
    let cancelled = false
    void ensureMathExtensions().then((exts) => {
      if (!cancelled) setMathExtensions(exts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const extensions = useMemo(() => buildSharedExtensions({ mathExtensions }), [mathExtensions])

  const previewEditor = useEditor({ extensions, editable: false }, [extensions])

  useEffect(() => {
    // No `setState({ kind: 'loading' })` here: the caller keys this modal on
    // `entryId`, so a different entry remounts the component and `loading` is
    // already the initial state.
    if (!previewEditor) return
    let cancelled = false
    void (async () => {
      try {
        const [entry, contentBytes] = await Promise.all([
          getEntry(entryId, activeVaultId),
          getEntryContent(entryId, activeVaultId),
        ])
        if (cancelled) return
        // Same exclusion rule the rest of this feature applies: a locked or
        // deleted entry is never rendered, no matter how it was reached.
        if (!entry || entry.is_locked || entry.is_deleted) {
          setState({ kind: 'unavailable' })
          return
        }
        const hasBody = !!contentBytes && contentBytes.length > 0
        if (hasBody) {
          previewEditor.commands.setContent(snapshotToPmJson(new Uint8Array(contentBytes)))
        }
        setState({
          kind: 'loaded',
          title: entry.title?.trim() || null,
          entryDate: entry.entry_date,
          hasBody,
        })
      } catch {
        if (!cancelled) setState({ kind: 'unavailable' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entryId, activeVaultId, previewEditor])

  const untitled = t('editor:untitled_entry', { defaultValue: 'Untitled' })
  const heading =
    state.kind === 'loaded'
      ? (state.title ?? untitled)
      : t('daily_chat.entry_preview.title', { defaultValue: 'Entry' })

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <Modal.Header>
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-title truncate text-xl font-semibold">{heading}</span>
            {state.kind === 'loaded' && (
              <span className="text-fg-muted text-xs">
                {formatEntryDateWithYear(state.entryDate, i18n.language)}
              </span>
            )}
          </div>
          {/* Only once the entry is known readable — offering Edit on an
              unavailable entry would navigate to a blank editor. */}
          {state.kind === 'loaded' && (
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              icon={<SquarePen className="size-3.5" aria-hidden />}
              onClick={() => onEdit(entryId)}
            >
              {t('daily_chat.entry_preview.edit', { defaultValue: 'Edit' })}
            </Button>
          )}
        </div>
      </Modal.Header>

      <Modal.Body>
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center gap-3 py-12">
            <InlineOrb state="listening" aria-hidden />
            <ShimmerText className="text-fg-secondary text-sm">
              {t('daily_chat.entry_preview.loading', { defaultValue: 'Opening entry…' })}
            </ShimmerText>
          </div>
        )}

        {state.kind === 'unavailable' && (
          <p className="text-fg-secondary py-6 text-sm">
            {t('daily_chat.entry_preview.unavailable', {
              defaultValue: "This entry can't be opened — it may have been deleted or locked.",
            })}
          </p>
        )}

        {state.kind === 'loaded' &&
          (state.hasBody ? (
            <div
              className={editorContentWrapperClass({
                justify: justifyEnabled,
                ...typography,
                // Pinned `relaxed` regardless of the writing preference: this
                // is a reading surface inside a dialog, where a denser setting
                // tuned for composing runs the paragraphs together.
                paragraphSpacing: 'relaxed',
              })}
            >
              <EditorContent editor={previewEditor} />
            </div>
          ) : (
            <p className="text-fg-muted py-6 text-sm italic">
              {t('daily_chat.entry_preview.empty', { defaultValue: 'This entry has no text.' })}
            </p>
          ))}
      </Modal.Body>
    </Modal>
  )
}
