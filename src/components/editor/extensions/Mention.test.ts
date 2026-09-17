import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EmojiShortcodes } from './EmojiShortcodes'
import { SlashMenuExtension } from './SlashMenu'
import { Mention } from './Mention'

describe('Mention', () => {
  it('registers the extension', () => {
    const editor = new Editor({ extensions: [StarterKit, Mention] })

    expect(editor.extensionManager.extensions.some((e) => e.name === 'mention')).toBe(true)
    editor.destroy()
  })

  // The stored `id`/`label` attrs are the whole payload of a mention — they ride
  // in the Yjs doc and are re-parsed from HTML by VersionHistoryModal /
  // EntryPreviewModal, so a one-way serialisation would silently drop mentions.
  it('round-trips id and label through HTML', () => {
    const editor = new Editor({ extensions: [StarterKit, Mention] })
    editor.commands.insertMention({ id: 'e1', label: 'Trip to Paris' })

    const html = editor.getHTML()
    expect(html).toContain('data-type="mention"')
    expect(html).toContain('data-id="e1"')
    expect(html).toContain('data-label="Trip to Paris"')

    editor.commands.setContent(html)
    const attrs: Record<string, unknown>[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'mention') attrs.push(node.attrs)
    })
    expect(attrs).toEqual([{ id: 'e1', label: 'Trip to Paris' }])
    editor.destroy()
  })

  // Same regression guard as EmojiShortcodes.test.ts: the editor mounts all
  // three together, and a shared/duplicate ProseMirror plugin key throws
  // `RangeError: Adding different instances of a keyed plugin`.
  it('mounts alongside EmojiShortcodes and SlashMenuExtension', () => {
    expect(
      () =>
        new Editor({
          extensions: [StarterKit, EmojiShortcodes, SlashMenuExtension, Mention],
        }),
    ).not.toThrow()
  })
})
