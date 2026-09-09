import { Extension, type Range } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { getSlashMenuItemsForQuery, SlashMenu, type SlashMenuItem } from '../SlashMenu'
import { getEditorMathEnabled } from '../../../hooks/useEditorMathEnabled'
import { editorSupportsMath } from '../../../lib/editorMath'
import { placeSlashMenu } from '../../../lib/slashMenuPlacement'

export interface SlashMenuOptions {
  /**
   * Host-supplied image insertion handler — wired to the existing
   * `useImagePicker` flow so the slash-menu "Image" row opens the same file
   * picker as the toolbar.
   */
  onInsertImage?: (editor: Editor, range: Range) => void
  /**
   * Host-supplied handler for "Attach image" — opens the file picker and adds
   * the image to the attachment strip instead of inserting inline.
   */
  onAttachImage?: () => void
  /** Opens the inline-math editor after the slash trigger is removed. */
  onInsertInlineMath?: () => void
  /** Opens the block-math editor after the slash trigger is removed. */
  onInsertBlockMath?: () => void
}

interface SlashCommandArgs {
  editor: Editor
  range: Range
  props: SlashMenuItem
}

/**
 * Slash-command extension: press "/" at the start of an empty paragraph to
 * open a pop-over of the bundle's 8 basic blocks. Arrow keys navigate,
 * Enter inserts the block, Escape closes.
 */
export const SlashMenuExtension = Extension.create<SlashMenuOptions>({
  name: 'slashMenu',

  addOptions() {
    return {
      onInsertImage: undefined,
      onAttachImage: undefined,
      onInsertInlineMath: undefined,
      onInsertBlockMath: undefined,
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashMenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slashMenuSuggestion'),
        char: '/',
        startOfLine: false,
        // Only trigger when the paragraph is empty before "/" — matches
        // Notion/Craft behaviour that avoids false positives mid-sentence.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          // Empty or near-empty block: paragraph contains only the "/" we
          // just typed.
          const blockBefore = state.doc.textBetween($from.start(), range.from, '\n', '\0')
          return blockBefore.trim().length === 0
        },
        items: ({ query }) =>
          getSlashMenuItemsForQuery(this.editor, query, {
            mathEnabled: getEditorMathEnabled() && editorSupportsMath(this.editor),
          }),
        command: ({ editor, range, props }: SlashCommandArgs) => {
          // Image needs the host's file-picker; delegate so the extension
          // stays pure. Use stable key instead of translated label.
          if (props.key === 'image') {
            editor.chain().focus().deleteRange(range).run()
            this.options.onInsertImage?.(editor, range)
            return
          }
          if (props.key === 'attach') {
            editor.chain().focus().deleteRange(range).run()
            this.options.onAttachImage?.()
            return
          }
          if (props.key === 'inline-math') {
            editor.chain().focus().deleteRange(range).run()
            this.options.onInsertInlineMath?.()
            return
          }
          if (props.key === 'block-math') {
            editor.chain().focus().deleteRange(range).run()
            this.options.onInsertBlockMath?.()
            return
          }
          props.command({ editor, range })
        },
        render: createSuggestionRenderer(),
      }),
    ]
  },
})

type RenderReturn = ReturnType<NonNullable<SuggestionOptions<SlashMenuItem>['render']>>

function createSuggestionRenderer(): NonNullable<SuggestionOptions<SlashMenuItem>['render']> {
  return () => {
    let root: Root | null = null
    let container: HTMLDivElement | null = null
    let currentItems: SlashMenuItem[] = []
    let activeIndex = 0
    let currentMaxHeight: number | undefined
    let currentProps: Parameters<NonNullable<RenderReturn['onStart']>>[0] | null = null

    const reposition = () => {
      if (!container || !currentProps?.clientRect) return
      const rect = currentProps.clientRect()
      if (!rect) return
      const placed = placeSlashMenu({
        caret: { top: rect.top, bottom: rect.bottom, left: rect.left },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      currentMaxHeight = placed.maxHeight
      container.style.left = `${placed.left}px`
      if (placed.placement === 'below') {
        container.style.top = `${placed.top}px`
        container.style.bottom = 'auto'
      } else {
        container.style.top = 'auto'
        container.style.bottom = `${placed.bottom}px`
      }
    }

    // Re-position on scroll (capture phase catches nested scrollable containers)
    // and on resize so the menu tracks the cursor even if the editor pane scrolls.
    const handleReposition = () => {
      reposition()
      render()
    }

    const render = () => {
      if (!root) return
      root.render(
        createElement(SlashMenu, {
          items: currentItems,
          activeIndex,
          maxHeight: currentMaxHeight,
          onSelect: (i: number) => {
            const item = currentItems[i]
            if (item && currentProps) {
              currentProps.command(item as never)
            }
          },
        }),
      )
    }

    return {
      onStart: (props) => {
        currentProps = props
        currentItems = props.items
        activeIndex = 0

        container = document.createElement('div')
        container.style.position = 'fixed'
        container.style.zIndex = '60'
        document.body.appendChild(container)
        root = createRoot(container)

        window.addEventListener('scroll', handleReposition, true)
        window.addEventListener('resize', handleReposition)

        reposition()
        render()
      },
      onUpdate: (props) => {
        currentProps = props
        currentItems = props.items
        activeIndex = Math.min(activeIndex, Math.max(0, currentItems.length - 1))
        reposition()
        render()
      },
      onKeyDown: ({ event }) => {
        if (event.key === 'Escape') {
          // Return false so the suggestion plugin's own Escape handler runs
          // and triggers onExit — we don't need to do it ourselves.
          return false
        }
        if (event.key === 'ArrowDown') {
          if (currentItems.length === 0) return false
          activeIndex = (activeIndex + 1) % currentItems.length
          render()
          return true
        }
        if (event.key === 'ArrowUp') {
          if (currentItems.length === 0) return false
          activeIndex = (activeIndex - 1 + currentItems.length) % currentItems.length
          render()
          return true
        }
        if (event.key === 'Enter') {
          const item = currentItems[activeIndex]
          if (item && currentProps) {
            currentProps.command(item as never)
            return true
          }
        }
        return false
      },
      onExit: () => {
        window.removeEventListener('scroll', handleReposition, true)
        window.removeEventListener('resize', handleReposition)

        if (root) {
          // Defer the unmount off the current React render so we don't
          // re-enter the renderer while React is still flushing the
          // pop-over's teardown effects.
          const doomedRoot = root
          const doomedContainer = container
          root = null
          container = null
          currentProps = null
          setTimeout(() => {
            doomedRoot.unmount()
            doomedContainer?.remove()
          }, 0)
        }
      },
    }
  }
}
