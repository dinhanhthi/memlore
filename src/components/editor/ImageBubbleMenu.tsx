import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection } from '@tiptap/pm/state'
import { useTranslation } from 'react-i18next'
import { AlignLeft, AlignRight, ArrowDown, ArrowUp, RectangleHorizontal } from 'lucide-react'
import { BubbleButton, TextBubbleButton, Separator, BubbleArrow } from './BubbleToolbar'
import { Tooltip } from '../common/Tooltip'
import {
  buildStepMoveTransaction,
  canStepMove,
  type StepDirection,
} from './extensions/EditorDropIndicator'
import { getEditorScrollTarget } from './bubbleMenuPositioning'

interface ImageBubbleMenuProps {
  editor: Editor
  scrollTarget?: HTMLElement | Window
}

type ImageAlign = 'left' | 'right' | 'full'

/**
 * Floating toolbar shown when an inline image is selected (image NodeSelection).
 * Offers float alignment (left / full / right) and size presets (S / M / L).
 * A distinct `pluginKey` keeps it independent from the text `EditorBubbleMenu`,
 * which hides itself for image selections.
 */
export function ImageBubbleMenu({ editor, scrollTarget }: ImageBubbleMenuProps) {
  const { t } = useTranslation('editor')

  // Derive the selected image's layout attrs reactively so the active
  // highlights stay in sync with each toolbar click without relying on the
  // parent component re-rendering on every transaction.
  const { align, width, canMoveUp, canMoveDown } = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const sel = ed.state.selection
      const node = sel instanceof NodeSelection ? sel.node : null
      const range = sel instanceof NodeSelection ? { from: sel.from, to: sel.to } : null
      return {
        align: (node?.attrs['data-align'] as ImageAlign | undefined) ?? 'full',
        width: (node?.attrs['data-width'] as number | null) ?? null,
        canMoveUp: range ? canStepMove(ed.state, range, 'up') : false,
        canMoveDown: range ? canStepMove(ed.state, range, 'down') : false,
      }
    },
  })

  const updateImage = (attrs: { 'data-align'?: ImageAlign; 'data-width'?: number }) => {
    editor.chain().focus().updateAttributes('image', attrs).run()
  }

  const handleFloatLeft = () => {
    updateImage({ 'data-align': 'left', 'data-width': width && width !== 100 ? width : 50 })
  }

  const handleFullWidth = () => {
    updateImage({ 'data-align': 'full', 'data-width': 100 })
  }

  const handleFloatRight = () => {
    updateImage({ 'data-align': 'right', 'data-width': width && width !== 100 ? width : 50 })
  }

  // Swap the selected image with its previous/next sibling block. Dispatched
  // as a single transaction so undo (Yjs) reverts the whole move at once.
  const handleStepMove = (direction: StepDirection) => {
    const sel = editor.state.selection
    if (!(sel instanceof NodeSelection)) return
    const tr = buildStepMoveTransaction(editor.state, { from: sel.from, to: sel.to }, direction)
    if (!tr) return
    editor.view.dispatch(tr)
    editor.view.focus()
  }

  const effectiveWidth = width ?? 100

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="imageBubbleMenu"
      shouldShow={({ editor: ed, state, view, element }) => {
        if (!ed.isEditable) return false
        const { selection: sel } = state
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') {
          return false
        }
        const isChildOfMenu = element.contains(document.activeElement)
        return view.hasFocus() || isChildOfMenu
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
            onClick={handleFloatLeft}
          >
            <AlignLeft className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('image_align.full')} placement="top">
          <BubbleButton
            label={t('image_align.full')}
            active={align === 'full' && effectiveWidth === 100}
            onClick={handleFullWidth}
          >
            <RectangleHorizontal className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Tooltip content={t('image_align.right')} placement="top">
          <BubbleButton
            label={t('image_align.right')}
            active={align === 'right'}
            onClick={handleFloatRight}
          >
            <AlignRight className="size-3.5" strokeWidth={1.75} />
          </BubbleButton>
        </Tooltip>
        <Separator />
        <Tooltip content={t('image_size.small')} placement="top">
          <TextBubbleButton
            label={t('image_size.small')}
            active={effectiveWidth === 30}
            onClick={() => updateImage({ 'data-width': 30 })}
          >
            S
          </TextBubbleButton>
        </Tooltip>
        <Tooltip content={t('image_size.medium')} placement="top">
          <TextBubbleButton
            label={t('image_size.medium')}
            active={effectiveWidth === 50}
            onClick={() => updateImage({ 'data-width': 50 })}
          >
            M
          </TextBubbleButton>
        </Tooltip>
        <Tooltip content={t('image_size.large')} placement="top">
          <TextBubbleButton
            label={t('image_size.large')}
            active={effectiveWidth === 70}
            onClick={() => updateImage({ 'data-width': 70 })}
          >
            L
          </TextBubbleButton>
        </Tooltip>
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
