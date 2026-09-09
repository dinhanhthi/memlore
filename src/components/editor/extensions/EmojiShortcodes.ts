import { Extension, InputRule } from '@tiptap/core'
import type { Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { EmojiShortcodeMenu } from '../EmojiShortcodeMenu'
import {
  resolveEmojiShortcode,
  searchEmojiShortcodes,
  type EmojiShortcodeMatch,
} from '../../../lib/emojiShortcodes'

interface EmojiShortcodeCommandArgs {
  editor: import('@tiptap/core').Editor
  range: Range
  props: EmojiShortcodeMatch
}

/**
 * Type `:smile:` (or pick from the autocomplete menu after `:`) to insert an
 * emoji inline. Shortcodes map to the keyword tokens in `emojiData.ts`.
 */
export const EmojiShortcodes = Extension.create({
  name: 'emojiShortcodes',

  addInputRules() {
    return [
      new InputRule({
        find: /:([a-zA-Z][a-zA-Z0-9_+-]*):$/,
        handler: ({ state, range, match }) => {
          const emoji = resolveEmojiShortcode(match[1] ?? '')
          if (!emoji) return
          const { tr } = state
          tr.insertText(emoji, range.from, range.to)
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<EmojiShortcodeMatch>({
        editor: this.editor,
        pluginKey: new PluginKey('emojiShortcodesSuggestion'),
        char: ':',
        allowSpaces: false,
        allowedPrefixes: null,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.spec.code) return false
          const charBefore = state.doc.textBetween(
            Math.max(0, range.from - 1),
            range.from,
            '\0',
            '\0',
          )
          if (/\d/.test(charBefore) || charBefore === '/') return false
          return true
        },
        items: ({ query }) => searchEmojiShortcodes(query),
        command: ({ editor, range, props }: EmojiShortcodeCommandArgs) => {
          editor.chain().focus().deleteRange(range).insertContent(props.char).run()
        },
        render: createEmojiSuggestionRenderer(),
      }),
    ]
  },
})

type RenderReturn = ReturnType<NonNullable<SuggestionOptions<EmojiShortcodeMatch>['render']>>

function createEmojiSuggestionRenderer(): NonNullable<
  SuggestionOptions<EmojiShortcodeMatch>['render']
> {
  return () => {
    let root: Root | null = null
    let container: HTMLDivElement | null = null
    let currentItems: EmojiShortcodeMatch[] = []
    let activeIndex = 0
    let currentProps: Parameters<NonNullable<RenderReturn['onStart']>>[0] | null = null

    const reposition = () => {
      if (!container || !currentProps?.clientRect) return
      const rect = currentProps.clientRect()
      if (!rect) return
      container.style.top = `${rect.bottom + window.scrollY + 6}px`
      container.style.left = `${rect.left + window.scrollX}px`
    }

    const handleReposition = () => reposition()

    const render = () => {
      if (!root) return
      root.render(
        createElement(EmojiShortcodeMenu, {
          items: currentItems,
          activeIndex,
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
        if (currentItems.length === 0) return

        container = document.createElement('div')
        container.style.position = 'absolute'
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

        if (currentItems.length === 0) {
          if (root) {
            window.removeEventListener('scroll', handleReposition, true)
            window.removeEventListener('resize', handleReposition)
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
          return
        }

        if (!container) {
          container = document.createElement('div')
          container.style.position = 'absolute'
          container.style.zIndex = '60'
          document.body.appendChild(container)
          root = createRoot(container)
          window.addEventListener('scroll', handleReposition, true)
          window.addEventListener('resize', handleReposition)
        }

        reposition()
        render()
      },
      onKeyDown: ({ event }) => {
        if (event.key === 'Escape') return false
        if (currentItems.length === 0) return false
        if (event.key === 'ArrowDown') {
          activeIndex = (activeIndex + 1) % currentItems.length
          render()
          return true
        }
        if (event.key === 'ArrowUp') {
          activeIndex = (activeIndex - 1 + currentItems.length) % currentItems.length
          render()
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
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
