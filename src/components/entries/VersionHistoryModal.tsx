import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Extension } from '@tiptap/core'
import { Eye, History, type LucideIcon } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useEntryVersions } from '../../hooks/useEntryVersions'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeDate, formatTime } from '../../lib/dates'
import { snapshotToPmJson } from '../../lib/yjs'
import { buildSharedExtensions } from '../editor/sharedExtensions'
import { ensureMathExtensions } from '../../lib/editorMath'
import type { VersionMeta } from '../../lib/tauri'
import { useEditorJustifyEnabled } from '../../hooks/useEditorJustifyEnabled'
import { useEditorTypography } from '../../hooks/useEditorTypography'
import { editorContentWrapperClass } from '../../lib/editorLayout'
import { cn } from '../../lib/cn'

interface VersionHistoryModalProps {
  entryId: string
  entryTitle: string | null
  onClose: () => void
}

/**
 * Two-panel version history browser: a list of past editing-session
 * snapshots on the left, a read-only preview of the selected version on
 * the right. The preview reuses `buildSharedExtensions` — the same
 * content-schema extensions as the live editor (`Editor.tsx`), minus
 * `Collaboration`/history and other editing-only affordances — so
 * historical content (tables, media, math, etc.) renders identically to
 * how it looked when captured. It's a plain (non-collaborative) TipTap
 * instance: each version's Yjs snapshot is decoded to ProseMirror JSON via
 * `snapshotToPmJson` and pushed in with `setContent` rather than bound
 * live, since the content is immutable and never edited here.
 */
export function VersionHistoryModal({ entryId, entryTitle, onClose }: VersionHistoryModalProps) {
  const { t, i18n } = useTranslation('editor')
  const resolvedTitle =
    entryTitle?.trim() || t('versionHistory.untitled_entry', { defaultValue: 'Untitled' })
  const timeFormat = useUiStore((s) => s.timeFormat)
  const justifyEnabled = useEditorJustifyEnabled()
  const typography = useEditorTypography()
  const { versions, isLoading, getVersionContent, restore } = useEntryVersions(entryId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [mathExtensions, setMathExtensions] = useState<Extension[]>([])

  // Force-load the math schema (if not already cached) so a version whose
  // content includes math nodes doesn't fail to parse — mirrors the
  // "force-load" rationale in `yjs.ts`/`Editor.tsx` for the live editor.
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

  const previewEditor = useEditor(
    {
      extensions,
      editable: false,
    },
    [extensions],
  )

  useEffect(() => {
    if (!previewEditor || selectedId === null) return
    let cancelled = false
    void getVersionContent(selectedId)
      .then((bytes) => {
        if (cancelled) return
        previewEditor.commands.setContent(snapshotToPmJson(bytes))
      })
      .catch((err: unknown) => {
        console.error('Failed to load version content:', err)
      })
    return () => {
      cancelled = true
    }
  }, [previewEditor, selectedId, getVersionContent])

  function handleConfirmRestore() {
    if (selectedId === null) return
    restore(selectedId)
    setConfirmOpen(false)
    onClose()
  }

  return (
    <Modal onClose={onClose} maxWidth={820}>
      <Modal.Header>
        <div className="font-title flex min-w-0 items-center text-xl font-semibold">
          <span className="shrink-0">
            {t('versionHistory.title_of', { defaultValue: 'Version history of' })}
          </span>
          <span className="min-w-0 truncate" title={resolvedTitle}>
            &nbsp;&quot;{resolvedTitle}&quot;
          </span>
        </div>
      </Modal.Header>
      <Modal.Body className="px-4!">
        <div className="border-border-default flex h-[60vh] overflow-hidden rounded-lg border">
          <div className="border-border-default flex w-65 shrink-0 flex-col overflow-y-auto border-r">
            {isLoading && <div className="text-fg-muted px-2 py-4 text-center text-xs">…</div>}
            {!isLoading && versions.length === 0 && (
              <VersionPlaceholder
                icon={History}
                message={t('versionHistory.empty', { defaultValue: 'No version history yet' })}
                className="flex-1"
              />
            )}
            {!isLoading && versions.length > 0 && (
              <div className="divide-border-subtle divide-y">
                {versions.map((version) => (
                  <VersionListRow
                    key={version.id}
                    version={version}
                    selected={version.id === selectedId}
                    hour12={timeFormat === '12h'}
                    language={i18n.language}
                    onClick={() => setSelectedId(version.id)}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {selectedId !== null && previewEditor ? (
              <div
                className={editorContentWrapperClass({
                  justify: justifyEnabled,
                  ...typography,
                })}
              >
                <EditorContent editor={previewEditor} />
              </div>
            ) : (
              <VersionPlaceholder
                icon={versions.length === 0 ? History : Eye}
                message={
                  versions.length === 0
                    ? t('versionHistory.empty', { defaultValue: 'No version history yet' })
                    : t('versionHistory.select_prompt', {
                        defaultValue: 'Select a version to preview',
                      })
                }
                className="h-full"
                textClassName="text-sm"
              />
            )}
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('versionHistory.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={selectedId === null}
        >
          {t('versionHistory.restore', { defaultValue: 'Restore' })}
        </Button>
      </Modal.Footer>
      <ConfirmDialog
        open={confirmOpen}
        title={t('versionHistory.confirm_title', { defaultValue: 'Restore this version?' })}
        description={t('versionHistory.confirm_description', {
          defaultValue:
            'The entry will be updated to match this version. The current content is kept in history and is not lost.',
        })}
        confirmLabel={t('versionHistory.restore', { defaultValue: 'Restore' })}
        onConfirm={handleConfirmRestore}
        onClose={() => setConfirmOpen(false)}
      />
    </Modal>
  )
}

interface VersionPlaceholderProps {
  icon: LucideIcon
  message: string
  className?: string
  textClassName?: string
}

function VersionPlaceholder({
  icon: Icon,
  message,
  className,
  textClassName = 'text-xs',
}: VersionPlaceholderProps) {
  return (
    <div
      className={cn(
        'text-fg-muted flex flex-col items-center justify-center gap-3 px-2 text-center',
        className,
      )}
    >
      <Icon className="size-8 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className={textClassName}>{message}</span>
    </div>
  )
}

interface VersionListRowProps {
  version: VersionMeta
  selected: boolean
  hour12: boolean
  language: string
  onClick: () => void
}

function VersionListRow({ version, selected, hour12, language, onClick }: VersionListRowProps) {
  const dateLabel = formatRelativeDate(version.createdAt, language)
  const timeLabel = formatTime(version.createdAt, language, hour12)

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-accent-soft text-accent-text' : 'text-fg hover:bg-surface-subtle',
      )}
    >
      <span className="text-xs font-medium">
        {dateLabel} · {timeLabel}
      </span>
      {version.previewText && (
        <span className="text-fg-muted text-2xs line-clamp-2">{version.previewText}</span>
      )}
    </button>
  )
}
