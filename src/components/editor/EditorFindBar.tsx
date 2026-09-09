import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { TextInput } from '../common/TextInput'
import { Button } from '../common/Button'
import { findPluginKey } from './extensions/Find'

interface EditorFindBarProps {
  /** Active TipTap editor — null when no entry is open. */
  editor: TipTapEditor | null
  /** Called when the user closes the bar (Esc, close button, or empty query). */
  onClose: () => void
  /** Incrementing counter — bump it externally to force the bar's input
   * to refocus + select. Lets ⌘F while the bar is open behave like
   * standard find UIs (re-grab focus, highlight current query for
   * easy replacement). */
  refocusTick?: number
}

/**
 * Find-in-editor bar. Pinned top-right of the editor panel; controls the
 * custom Find extension on the TipTap editor.
 *
 * Keyboard:
 * - Enter → next match
 * - Shift+Enter → previous match
 * - Esc → close (caller clears query + un-mounts the bar)
 */
export function EditorFindBar({ editor, onClose, refocusTick }: EditorFindBarProps) {
  const { t } = useTranslation('palette')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Re-read storage snapshot on each render for the counter.
  // We don't subscribe — the editor mutates storage synchronously, and the
  // UI re-renders via local `query` state changes anyway.
  const findStorage = editor?.storage.find
  const total = findStorage?.total ?? 0
  const currentIndex = findStorage?.currentIndex ?? 0

  // Push query changes to the extension. Debouncing not needed here —
  // setFindQuery is cheap (single doc scan) and the user expects instant feedback.
  useEffect(() => {
    if (!editor) return
    editor.commands.setFindQuery(query)
  }, [editor, query])

  // Auto-focus on mount.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Re-focus + select when the caller bumps refocusTick (e.g. ⌘F while
  // the bar is already open — should re-grab focus and select the query
  // so the user can immediately type a new search term).
  useEffect(() => {
    if (refocusTick === undefined) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [refocusTick])

  // Force a re-render whenever the editor dispatches a transaction that
  // affects find state: doc edits (matches may have moved/changed) or a
  // find-specific meta (set/next/prev/clear). Skip pure selection changes
  // to avoid re-rendering the bar on every cursor move.
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    if (!editor) return
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged || transaction.getMeta(findPluginKey) !== undefined) {
        forceUpdate((n) => n + 1)
      }
    }
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor])

  const goNext = () => editor?.commands.goToNextMatch()
  const goPrev = () => editor?.commands.goToPrevMatch()

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) goPrev()
      else goNext()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const counter = total > 0 ? `${currentIndex + 1} / ${total}` : t('find.no_matches')

  return (
    <div
      role="search"
      aria-label={t('find.aria_label')}
      className="border-border-default bg-elevated absolute top-3 right-3 z-10 flex w-1/2 items-center gap-1.5 rounded-full border px-2 py-1.5"
    >
      <TextInput
        ref={inputRef as React.Ref<HTMLInputElement & HTMLTextAreaElement>}
        value={query}
        onChange={(next) => setQuery(next)}
        onKeyDown={
          handleKeyDown as React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>
        }
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        className="xj-input-bare min-w-0 flex-1 border-transparent bg-transparent py-1 shadow-none hover:border-transparent"
      />
      <span
        className="text-fg-muted shrink-0 text-xs tabular-nums"
        aria-live="polite"
        aria-atomic="true"
      >
        {counter}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={goPrev}
        disabled={total === 0}
        aria-label={t('find.previous')}
        icon={<ChevronUp className="size-4" />}
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={goNext}
        disabled={total === 0}
        aria-label={t('find.next')}
        icon={<ChevronDown className="size-4" />}
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={onClose}
        aria-label={t('find.close')}
        icon={<X className="size-4" />}
      />
    </div>
  )
}
