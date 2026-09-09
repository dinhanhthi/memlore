import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { TextInput } from '../common/TextInput'
import { cn } from '../../lib/cn'
import { TAG_PALETTE } from '../../lib/tagColors'
import type { Tag } from '../../types/journal'

const PRESET_COLORS = TAG_PALETTE

export interface TagEditorModalProps {
  /** null = create mode; existing tag = edit mode. */
  tag: Tag | null
  /** Entry count for the tag — used in the delete confirmation copy. Ignored in create mode. */
  entryCount?: number
  /** Save handler. `color = null` means "no color". */
  onSave: (patch: { name: string; color: string | null }) => Promise<void>
  /** Delete handler — only invoked in edit mode after inline confirmation. */
  onDelete?: () => Promise<void>
  onClose: () => void
}

type Mode = 'edit' | 'confirm-delete'

export function TagEditorModal({
  tag,
  entryCount = 0,
  onSave,
  onDelete,
  onClose,
}: TagEditorModalProps) {
  const { t } = useTranslation('nav')
  const isEdit = tag !== null

  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState<string | null>(tag?.color ?? PRESET_COLORS[0].hex)
  const [mode, setMode] = useState<Mode>('edit')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('tag_editor.name_required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave({ name: trimmed, color })
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!onDelete) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  // ─── Delete confirmation step ──────────────────────────────────────────────
  if (mode === 'confirm-delete' && tag) {
    return (
      <Modal onClose={onClose} maxWidth={420} disableEsc={busy} disableBackdrop={busy}>
        <Modal.Header
          description={
            <>
              <Trans
                i18nKey="tag_editor.delete_body"
                ns="nav"
                values={{ name: tag.name }}
                components={{ b: <span className="text-fg font-semibold" /> }}
              />{' '}
              {entryCount > 0
                ? t('tag_editor.delete_usage', { count: entryCount })
                : t('tag_editor.delete_unused')}
            </>
          }
        >
          {t('tag_editor.delete_title')}
        </Modal.Header>
        {error && (
          <Modal.Body fitContent>
            <p className="text-danger-text text-xs">{error}</p>
          </Modal.Body>
        )}
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={() => setMode('edit')} disabled={busy}>
            {t('tag_editor.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            loading={busy}
            onClick={handleConfirmDelete}
            disabled={busy}
          >
            {busy ? t('tag_editor.deleting') : t('tag_editor.delete')}
          </Button>
        </Modal.Footer>
      </Modal>
    )
  }

  // ─── Edit / create form ────────────────────────────────────────────────────
  // Layout matches settings form modals (e.g. JournalForm): plain Header
  // title, default Body padding, form as flex column filling the dialog.
  return (
    <Modal onClose={onClose} maxWidth={420} disableEsc={busy} disableBackdrop={busy}>
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <Modal.Header>
          {isEdit ? t('tag_editor.edit_title') : t('tag_editor.create_title')}
        </Modal.Header>
        <Modal.Body fitContent className="flex flex-col gap-4">
          <div>
            <label htmlFor="tag-name" className="text-fg mb-1 block text-sm font-medium">
              {t('tag_editor.name_label')}
            </label>
            <TextInput
              id="tag-name"
              value={name}
              onChange={(v) => {
                setName(v)
                setError(null)
              }}
              placeholder={t('tag_editor.name_placeholder')}
              autoFocus
            />
            {error && <p className="text-danger-text mt-1 text-xs">{error}</p>}
          </div>

          <div>
            <span className="text-fg mb-2 block text-sm font-medium">
              {t('tag_editor.color_label')}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  aria-label={c.name}
                  onClick={() => setColor(c.hex)}
                  className={cn(
                    'h-8 w-8 rounded-full transition-[filter] duration-200 hover:brightness-110',
                    color === c.hex && 'ring-focus-ring shadow-sm ring-2 ring-offset-2',
                  )}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
              <button
                type="button"
                aria-label={t('tag_editor.no_color')}
                onClick={() => setColor(null)}
                className={cn(
                  'border-border-default text-fg-muted flex h-8 w-8 items-center justify-center rounded-full border text-xs transition-[filter] duration-200 hover:brightness-110',
                  color === null && 'ring-focus-ring shadow-sm ring-2 ring-offset-2',
                )}
                title={t('tag_editor.no_color')}
              >
                ✕
              </button>
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          {isEdit && onDelete && (
            <Button
              variant="ghost"
              type="button"
              size="sm"
              onClick={() => setMode('confirm-delete')}
              className="text-danger mr-auto"
              disabled={busy}
            >
              {t('tag_editor.delete_tag')}
            </Button>
          )}
          <Button variant="ghost" type="button" size="sm" onClick={onClose} disabled={busy}>
            {t('tag_editor.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy}>
            {busy ? t('tag_editor.saving') : isEdit ? t('tag_editor.save') : t('tag_editor.create')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
