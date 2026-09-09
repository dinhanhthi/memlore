import type { Editor } from '@tiptap/react'
import { isTextSelection } from '@tiptap/core'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection } from '@tiptap/pm/state'
import { useTranslation } from 'react-i18next'
import {
  Bold,
  Italic,
  Strikethrough,
  Underline,
  Highlighter,
  Link as LinkIcon,
  Heading2,
  Code,
  WandSparkles,
} from 'lucide-react'
import { BubbleButton, Separator, BubbleArrow } from './BubbleToolbar'
import { Tooltip } from '../common/Tooltip'
import { toast } from '../../lib/toast'

interface EditorBubbleMenuProps {
  editor: Editor
  onRewriteSelection?: (selectedText: string) => Promise<string>
  /** When set, the Rewrite button renders DISABLED with this tooltip instead
   *  of disappearing — e.g. "turn on Persona to use this". */
  rewriteDisabledReason?: string
}

/** A rewrite result is only safe to insert into the exact document revision
 * that supplied its source text. Comparing selected text alone misses edits
 * elsewhere that leave the old numeric range looking identical. */
export function isRewriteSnapshotCurrent(requestDoc: unknown, currentDoc: unknown): boolean {
  return requestDoc === currentDoc
}

// Structural type so we don't depend on @tiptap/core module augmentation from
// every extension (Bold, Italic, Link, etc.) being in scope here. Starter-kit
// registers them globally through Editor.tsx; we just need TS to allow the
// chained call shape.
interface Chain {
  toggleBold: () => Chain
  toggleItalic: () => Chain
  toggleStrike: () => Chain
  toggleUnderline: () => Chain
  toggleHighlight: () => Chain
  toggleHeading: (attrs: { level: number }) => Chain
  toggleCode: () => Chain
  extendMarkRange: (markName: string) => Chain
  setLink: (attrs: { href: string }) => Chain
  focus: () => Chain
  run: () => boolean
}

const c = (editor: Editor): Chain => editor.chain() as unknown as Chain

export function EditorBubbleMenu({
  editor,
  onRewriteSelection,
  rewriteDisabledReason,
}: EditorBubbleMenuProps) {
  const { t } = useTranslation('editor')
  const handleLink = () => {
    const prev = editor.isActive('link')
    const url = window.prompt('URL', prev ? '' : 'https://')
    if (url === null) return
    if (url === '') {
      c(editor).focus().extendMarkRange('link').setLink({ href: '' }).run()
      return
    }
    if (!/^(https?|mailto|tel):/i.test(url)) return
    c(editor).focus().extendMarkRange('link').setLink({ href: url }).run()
  }
  const handleRewrite = async () => {
    if (!onRewriteSelection) return
    const { from, to } = editor.state.selection
    const requestDoc = editor.state.doc
    const selectedText = editor.state.doc.textBetween(from, to, '\n')
    if (!selectedText.trim()) return
    try {
      const rewritten = await onRewriteSelection(selectedText)
      // Do not overwrite content after any local or remote transaction while
      // the provider was responding. Positions are not stable across Yjs
      // updates, even if the current range happens to contain the old text.
      if (!isRewriteSnapshotCurrent(requestDoc, editor.state.doc)) {
        toast(t('bubble.rewrite_changed'))
        return
      }
      editor.view.dispatch(editor.state.tr.insertText(rewritten, from, to))
    } catch {
      toast(t('bubble.rewrite_failed'))
    }
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: ed, state, view, from, to, element }) => {
        const { doc, selection } = state
        const { empty } = selection

        // A NodeSelection (image, video, audio, hr, …) is non-empty and
        // non-text, so it would otherwise leak the text-formatting menu.
        // Each selectable media node has its own bubble menu.
        if (selection instanceof NodeSelection) {
          return false
        }

        const isEmptyTextBlock =
          !doc.textBetween(from, to).length && isTextSelection(state.selection)
        const isChildOfMenu = element.contains(document.activeElement)
        const hasEditorFocus = view.hasFocus() || isChildOfMenu

        if (!hasEditorFocus || empty || isEmptyTextBlock || !ed.isEditable) {
          return false
        }

        return true
      }}
      options={{ offset: 8, placement: 'top' }}
    >
      <div className="border-border-default bg-elevated relative inline-flex items-center gap-0.5 rounded-xl border p-1 shadow-md">
        <Tooltip content={t('bubble.bold')} placement="top">
          <BubbleButton
            label={t('bubble.bold')}
            active={editor.isActive('bold')}
            onClick={() => c(editor).focus().toggleBold().run()}
          >
            <Bold className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('bubble.italic')} placement="top">
          <BubbleButton
            label={t('bubble.italic')}
            active={editor.isActive('italic')}
            onClick={() => c(editor).focus().toggleItalic().run()}
          >
            <Italic className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('bubble.strike')} placement="top">
          <BubbleButton
            label={t('bubble.strike')}
            active={editor.isActive('strike')}
            onClick={() => c(editor).focus().toggleStrike().run()}
          >
            <Strikethrough className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('bubble.underline')} placement="top">
          <BubbleButton
            label={t('bubble.underline')}
            active={editor.isActive('underline')}
            onClick={() => c(editor).focus().toggleUnderline().run()}
          >
            <Underline className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('bubble.highlight')} placement="top">
          <BubbleButton
            label={t('bubble.highlight')}
            active={editor.isActive('highlight')}
            onClick={() => c(editor).focus().toggleHighlight().run()}
          >
            <Highlighter className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Separator />
        <Tooltip content={t('bubble.link')} placement="top">
          <BubbleButton
            label={t('bubble.link')}
            active={editor.isActive('link')}
            onClick={handleLink}
          >
            <LinkIcon className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('bubble.heading')} placement="top">
          <BubbleButton
            label={t('bubble.heading')}
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => c(editor).focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('bubble.inline_code')} placement="top">
          <BubbleButton
            label={t('bubble.inline_code')}
            active={editor.isActive('code')}
            onClick={() => c(editor).focus().toggleCode().run()}
          >
            <Code className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        {onRewriteSelection && (
          <Tooltip content={rewriteDisabledReason ?? t('bubble.rewrite')} placement="top">
            <BubbleButton
              label={t('bubble.rewrite')}
              active={false}
              disabled={rewriteDisabledReason != null}
              onClick={() => void handleRewrite()}
            >
              <WandSparkles className="size-3.5" strokeWidth={1.75} />
            </BubbleButton>
          </Tooltip>
        )}
        <BubbleArrow />
      </div>
    </BubbleMenu>
  )
}
