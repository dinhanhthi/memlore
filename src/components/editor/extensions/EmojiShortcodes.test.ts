import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EmojiShortcodes } from './EmojiShortcodes'
import { SlashMenuExtension } from './SlashMenu'

describe('EmojiShortcodes', () => {
  it('registers the extension', () => {
    const editor = new Editor({
      extensions: [StarterKit, EmojiShortcodes],
    })

    expect(editor.extensionManager.extensions.some((e) => e.name === 'emojiShortcodes')).toBe(true)
    editor.destroy()
  })

  // Regression test for a real crash: both this extension and SlashMenuExtension
  // register a `@tiptap/suggestion` ProseMirror plugin. Without distinct
  // `pluginKey`s, both plugins default to the same key and ProseMirror throws
  // `RangeError: Adding different instances of a keyed plugin (suggestion$)`
  // as soon as the editor mounts — crashing the whole <Editor> React tree.
  it('mounts alongside SlashMenuExtension without a duplicate-plugin-key crash', () => {
    expect(
      () =>
        new Editor({
          extensions: [StarterKit, EmojiShortcodes, SlashMenuExtension],
        }),
    ).not.toThrow()
  })
})
