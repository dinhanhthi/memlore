import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Mathematics from '@tiptap/extension-mathematics'
import { MathInputRules } from './MathInputRules'

// Extension order mirrors src/lib/editorMath.ts (Mathematics before
// MathInputRules). TipTap consults input rules from later-registered
// extensions first, so this order is what lets MathInputRules win over the
// bundled Mathematics rules — see the order-swap test below.
function createEditor(order: 'production' | 'swapped' = 'production') {
  const math = Mathematics.configure({ katexOptions: { throwOnError: false } })
  return new Editor({
    extensions:
      order === 'production'
        ? [StarterKit, math, MathInputRules]
        : [StarterKit, MathInputRules, math],
  })
}

/** Simulates real typing so input rules fire the same way they do live. */
function typeText(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
    )
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(char, from, to))
    }
  }
}

function collectNodesByType(editor: Editor, typeName: string) {
  const nodes: { latex: unknown }[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) nodes.push({ latex: node.attrs.latex })
  })
  return nodes
}

describe('MathInputRules', () => {
  it('registers when inlineMath is available in the schema', () => {
    const editor = createEditor()

    expect(editor.schema.nodes.inlineMath).toBeDefined()
    expect(editor.extensionManager.extensions.some((e) => e.name === 'mathInputRules')).toBe(true)

    editor.destroy()
  })

  it('converts $latex$ to a single inline math node with no leftover text', () => {
    const editor = createEditor()
    typeText(editor, '$e=mc^2$')

    const inline = collectNodesByType(editor, 'inlineMath')
    const block = collectNodesByType(editor, 'blockMath')
    expect(inline).toHaveLength(1)
    expect(inline[0].latex).toBe('e=mc^2')
    expect(block).toHaveLength(0)
    expect(editor.getText()).not.toContain('$')

    editor.destroy()
  })

  it('converts $$latex$$ to a single block math node, not inline, with no leftover text or replacement chars', () => {
    const editor = createEditor()
    typeText(editor, '$$e=mc^2$$')

    const inline = collectNodesByType(editor, 'inlineMath')
    const block = collectNodesByType(editor, 'blockMath')
    expect(block).toHaveLength(1)
    expect(block[0].latex).toBe('e=mc^2')
    expect(inline).toHaveLength(0)

    const text = editor.getText()
    expect(text).not.toContain('$')
    expect([...inline, ...block].some((n) => n.latex === '%leaf%')).toBe(false)

    editor.destroy()
  })

  it('converts $$latex$$ mid-paragraph into a block math node and keeps preceding text', () => {
    const editor = createEditor()
    typeText(editor, 'note $$e=mc^2$$')

    const block = collectNodesByType(editor, 'blockMath')
    expect(block).toHaveLength(1)
    expect(block[0].latex).toBe('e=mc^2')
    expect(editor.getText()).toContain('note')

    editor.destroy()
  })

  it('does not create math nodes for currency amounts like $5 and $10', () => {
    const editor = createEditor()
    typeText(editor, '$5 and $10')

    const inline = collectNodesByType(editor, 'inlineMath')
    const block = collectNodesByType(editor, 'blockMath')
    expect(inline).toHaveLength(0)
    expect(block).toHaveLength(0)
    expect(editor.getText()).toBe('$5 and $10')

    editor.destroy()
  })

  it('converts adjacent expressions $a$ $b$ into two separate inline nodes', () => {
    const editor = createEditor()
    typeText(editor, '$a$ $b$')

    const inline = collectNodesByType(editor, 'inlineMath')
    expect(inline).toHaveLength(2)
    expect(inline[0].latex).toBe('a')
    expect(inline[1].latex).toBe('b')
    expect(editor.getText()).not.toContain('$')

    editor.destroy()
  })

  it('never swallows an existing math node between typed dollars', () => {
    // Leaf nodes serialize as '%leaf%' while input rules match text; without a
    // guard, typing `$` + <math node> + `$` matches `$%leaf%$` and replaces the
    // existing node with a new one whose latex is the literal marker.
    const editor = createEditor()
    typeText(editor, '$')
    editor.chain().focus('end').insertInlineMath({ latex: 'x' }).run()
    editor.commands.focus('end')
    typeText(editor, '$')

    const inline = collectNodesByType(editor, 'inlineMath')
    expect(inline).toHaveLength(1)
    expect(inline[0].latex).toBe('x')

    editor.destroy()
  })

  it('undoInputRule reverts $latex$ back to the literal text', () => {
    const editor = createEditor()
    typeText(editor, '$e=mc^2$')
    editor.commands.undoInputRule()

    expect(collectNodesByType(editor, 'inlineMath')).toHaveLength(0)
    expect(editor.getText()).toBe('$e=mc^2$')

    editor.destroy()
  })

  it('history undo reverts the $$latex$$ conversion (undoInputRule cannot)', () => {
    // Inserting a block node triggers a selection-normalizing transaction,
    // which clears TipTap's stored input-rule state (any selectionSet/
    // docChanged transaction does) — so backspace's undoInputRule is a no-op
    // for the block rule. History undo remains the recovery path.
    const editor = createEditor()
    typeText(editor, '$$e=mc^2$$')
    editor.commands.undoInputRule()
    expect(collectNodesByType(editor, 'blockMath')).toHaveLength(1)

    editor.commands.undo()
    expect(collectNodesByType(editor, 'blockMath')).toHaveLength(0)

    editor.destroy()
  })

  it('converts $$latex$$ typed mid-paragraph and keeps the text after the cursor', () => {
    const editor = createEditor()
    typeText(editor, 'before after')
    editor.commands.setTextSelection(8) // between "before " and "after"
    typeText(editor, '$$x$$')

    const block = collectNodesByType(editor, 'blockMath')
    expect(block).toHaveLength(1)
    expect(block[0].latex).toBe('x')
    const text = editor.getText()
    expect(text).toContain('before')
    expect(text).toContain('after')

    editor.destroy()
  })

  it('depends on registration order: bundled rules win when Mathematics registers later', () => {
    // Documents the mechanism the production order in editorMath.ts relies on:
    // TipTap tries later-registered extensions' input rules first. If someone
    // "moves MathInputRules earlier", the bundled `$$…$$` → inline rule wins.
    const editor = createEditor('swapped')
    typeText(editor, '$$e=mc^2$$')

    expect(collectNodesByType(editor, 'blockMath')).toHaveLength(0)
    expect(collectNodesByType(editor, 'inlineMath')).toHaveLength(1)

    editor.destroy()
  })
})
