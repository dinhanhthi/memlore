import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection } from '@tiptap/pm/state'
import { useTranslation } from 'react-i18next'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  RectangleHorizontal,
} from 'lucide-react'
import { BubbleButton, TextBubbleButton, Separator, BubbleArrow } from './BubbleToolbar'
import { Tooltip } from '../common/Tooltip'
import {
  buildStepMoveTransaction,
  canStepMove,
  type StepDirection,
} from './extensions/EditorDropIndicator'
import { getEditorScrollTarget } from './bubbleMenuPositioning'

interface VideoBubbleMenuProps {
  editor: Editor
  scrollTarget?: HTMLElement | Window
}

type VideoAlign = 'left' | 'right' | null

/**
 * Floating toolbar shown when an inline video is selected (video NodeSelection).
 * Mirrors `ImageBubbleMenu` visually so images and videos share one toolbar
 * language — it sits *above* the clip rather than overlaying it. Offers float
 * alignment (left / center / right), a full-width preset, size presets (S/M/L),
 * and the ↑/↓ block-move buttons.
 *
 * Unlike the image menu, `shouldShow` gates purely on the selection — never on
 * `view.hasFocus()`. A native `<video controls>` element can pull DOM focus out
 * of the ProseMirror view into its control shadow DOM, which would otherwise
 * hide the toolbar; the NodeSelection is the correct signal (selected → show).
 */
export function VideoBubbleMenu({ editor, scrollTarget }: VideoBubbleMenuProps) {
  const { t } = useTranslation('editor')

  const { align, width, canMoveUp, canMoveDown } = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const sel = ed.state.selection
      const node = sel instanceof NodeSelection ? sel.node : null
      const range = sel instanceof NodeSelection ? { from: sel.from, to: sel.to } : null
      return {
        align: (node?.attrs['data-align'] as VideoAlign) ?? null,
        width: (node?.attrs['data-width'] as number | null) ?? null,
        canMoveUp: range ? canStepMove(ed.state, range, 'up') : false,
        canMoveDown: range ? canStepMove(ed.state, range, 'down') : false,
      }
    },
  })

  // Resolve the selected video's position on demand from the live selection so
  // setters always target the current node (the selector value can lag a tick).
  const videoPos = (): number | null => {
    const sel = editor.state.selection
    return sel instanceof NodeSelection ? sel.from : null
  }

  const setVideoWidth = (w: number | null) => {
    const pos = videoPos()
    if (pos == null) return
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'data-width', w))
    editor.view.focus()
  }

  const setVideoAlign = (a: VideoAlign) => {
    const pos = videoPos()
    if (pos == null) return
    const tr = editor.state.tr.setNodeAttribute(pos, 'data-align', a)
    // A float needs a bounded width, else it fills the whole column and stops
    // reading as "floated". Seed 50% when unsized *or* full-width — a 100% float
    // plus its 1rem gutter would overflow. Mirrors `ImageBubbleMenu`.
    if ((a === 'left' || a === 'right') && (width == null || width === 100)) {
      tr.setNodeAttribute(pos, 'data-width', 50)
    }
    editor.view.dispatch(tr)
    editor.view.focus()
  }

  const videoFloated = align === 'left' || align === 'right'
  // "Full" always means full-width centered block — so it also clears any float
  // (a floated clip at 100% would overflow by its 1rem gutter). Toggles back to
  // intrinsic size when re-clicked.
  const videoIsFull = width === 100 && !videoFloated
  const setVideoFull = () => {
    const pos = videoPos()
    if (pos == null) return
    const tr = editor.state.tr.setNodeAttribute(pos, 'data-width', videoIsFull ? null : 100)
    if (!videoIsFull) tr.setNodeAttribute(pos, 'data-align', null)
    editor.view.dispatch(tr)
    editor.view.focus()
  }

  // Swap the selected video with its previous/next sibling block. Dispatched as
  // a single transaction so undo (Yjs) reverts the whole move at once.
  const handleStepMove = (direction: StepDirection) => {
    const sel = editor.state.selection
    if (!(sel instanceof NodeSelection)) return
    const tr = buildStepMoveTransaction(editor.state, { from: sel.from, to: sel.to }, direction)
    if (!tr) return
    editor.view.dispatch(tr)
    editor.view.focus()
  }

  const sizePresets: Array<{ value: number; label: string; text: string }> = [
    { value: 30, label: t('image_size.small'), text: 'S' },
    { value: 50, label: t('image_size.medium'), text: 'M' },
    { value: 70, label: t('image_size.large'), text: 'L' },
  ]

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="videoBubbleMenu"
      shouldShow={({ editor: ed, state }) => {
        if (!ed.isEditable) return false
        const { selection: sel } = state
        return sel instanceof NodeSelection && sel.node.type.name === 'video'
      }}
      options={{
        offset: 8,
        placement: 'top',
        scrollTarget: scrollTarget ?? getEditorScrollTarget(editor),
      }}
    >
      <div className="border-border-default bg-elevated relative inline-flex items-center gap-0.5 rounded-xl border p-1 shadow-md">
        <Tooltip content={t('image_align.left')} placement="top">
          <BubbleButton
            label={t('image_align.left')}
            active={align === 'left'}
            onClick={() => setVideoAlign('left')}
          >
            <AlignLeft className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('image_align.center')} placement="top">
          <BubbleButton
            label={t('image_align.center')}
            active={!videoFloated && !videoIsFull}
            onClick={() => setVideoAlign(null)}
          >
            <AlignCenter className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('image_align.right')} placement="top">
          <BubbleButton
            label={t('image_align.right')}
            active={align === 'right'}
            onClick={() => setVideoAlign('right')}
          >
            <AlignRight className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('image_align.full')} placement="top">
          <BubbleButton label={t('image_align.full')} active={videoIsFull} onClick={setVideoFull}>
            <RectangleHorizontal className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Separator />
        {sizePresets.map(({ value, label, text }) => (
          <Tooltip key={value} content={label} placement="top">
            <TextBubbleButton
              label={label}
              active={width === value}
              onClick={() => setVideoWidth(width === value ? null : value)}
            >
              {text}
            </TextBubbleButton>
          </Tooltip>
        ))}
        <Separator />
        <Tooltip content={t('image_move.up')} placement="top">
          <BubbleButton
            label={t('image_move.up')}
            active={false}
            disabled={!canMoveUp}
            onClick={() => handleStepMove('up')}
          >
            <ArrowUp className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('image_move.down')} placement="top">
          <BubbleButton
            label={t('image_move.down')}
            active={false}
            disabled={!canMoveDown}
            onClick={() => handleStepMove('down')}
          >
            <ArrowDown className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <BubbleArrow />
      </div>
    </BubbleMenu>
  )
}
