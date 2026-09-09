import { describe, it, expect } from 'vitest'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import { Schema } from '@tiptap/pm/model'
import {
  EditorDropIndicator,
  getDragRange,
  buildMoveTransaction,
  buildStepMoveTransaction,
  canStepMove,
} from './EditorDropIndicator'
import type { EditorView } from '@tiptap/pm/view'

// Minimal schema with a block atom node mirroring the editor's image node.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0] as const,
    },
    text: { group: 'inline' },
    image: {
      group: 'block',
      atom: true,
      selectable: true,
      toDOM: () => ['img'] as const,
    },
  },
})

// doc: <image/>(0..1) <p>hello</p>(1..8)
const imageFirstDoc = () =>
  schema.node('doc', null, [
    schema.node('image'),
    schema.node('paragraph', null, [schema.text('hello')]),
  ])

// doc: <p>hello</p>(0..7) <image/>(7..8)
const imageLastDoc = () =>
  schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hello')]),
    schema.node('image'),
  ])

describe('EditorDropIndicator', () => {
  it('exports a named TipTap extension', () => {
    expect(EditorDropIndicator.name).toBe('editorDropIndicator')
    expect(EditorDropIndicator.type).toBe('extension')
  })

  describe('getDragRange', () => {
    it('returns range from view.dragging.node when set', () => {
      const mockNodeSelection = { from: 4, to: 5 }
      const view = {
        dragging: { node: mockNodeSelection },
        state: { selection: { from: 0, to: 0 } },
      } as unknown as EditorView

      expect(getDragRange(view)).toEqual({ from: 4, to: 5 })
    })

    it('falls back to NodeSelection on editor state', () => {
      const selection = { from: 10, to: 11 }
      Object.setPrototypeOf(selection, NodeSelection.prototype)
      const view = {
        dragging: null,
        state: { selection },
      } as unknown as EditorView

      expect(getDragRange(view)).toEqual({ from: 10, to: 11 })
    })

    it('returns null when nothing is being dragged', () => {
      const view = {
        dragging: null,
        state: { selection: { from: 2, to: 2, empty: true } },
      } as unknown as EditorView

      expect(getDragRange(view)).toBeNull()
    })
  })

  describe('buildMoveTransaction', () => {
    it('moves the node forward past a following block', () => {
      const state = EditorState.create({ doc: imageFirstDoc() })
      const tr = buildMoveTransaction(state, { from: 0, to: 1 }, 8)

      expect(tr).not.toBeNull()
      const next = state.apply(tr!)
      expect(next.doc.childCount).toBe(2)
      expect(next.doc.child(0).type.name).toBe('paragraph')
      expect(next.doc.child(1).type.name).toBe('image')
    })

    it('moves the node backward before a preceding block', () => {
      const state = EditorState.create({ doc: imageLastDoc() })
      const tr = buildMoveTransaction(state, { from: 7, to: 8 }, 0)

      expect(tr).not.toBeNull()
      const next = state.apply(tr!)
      expect(next.doc.child(0).type.name).toBe('image')
      expect(next.doc.child(1).type.name).toBe('paragraph')
    })

    it('keeps the moved node selected at its new position', () => {
      const state = EditorState.create({ doc: imageFirstDoc() })
      const tr = buildMoveTransaction(state, { from: 0, to: 1 }, 8)

      const next = state.apply(tr!)
      expect(next.selection).toBeInstanceOf(NodeSelection)
      expect(next.doc.nodeAt(next.selection.from)?.type.name).toBe('image')
    })

    it('returns null when the drop lands on the node itself', () => {
      const state = EditorState.create({ doc: imageFirstDoc() })

      expect(buildMoveTransaction(state, { from: 0, to: 1 }, 0)).toBeNull()
      expect(buildMoveTransaction(state, { from: 0, to: 1 }, 1)).toBeNull()
    })

    it('returns null when the range does not cover a single node', () => {
      const state = EditorState.create({ doc: imageFirstDoc() })

      // No node starts at the end of the document.
      expect(buildMoveTransaction(state, { from: 8, to: 9 }, 0)).toBeNull()
      // Range points into the middle of a text node.
      expect(buildMoveTransaction(state, { from: 3, to: 4 }, 0)).toBeNull()
    })
  })

  describe('buildStepMoveTransaction / canStepMove', () => {
    // doc: <p>one</p>(0..5) <image/>(5..6) <p>two</p>(6..11)
    const middleDoc = () =>
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('one')]),
        schema.node('image'),
        schema.node('paragraph', null, [schema.text('two')]),
      ])

    it('moves the node up above the previous sibling block', () => {
      const state = EditorState.create({ doc: middleDoc() })
      const tr = buildStepMoveTransaction(state, { from: 5, to: 6 }, 'up')

      expect(tr).not.toBeNull()
      const next = state.apply(tr!)
      expect(next.doc.child(0).type.name).toBe('image')
      expect(next.doc.child(1).textContent).toBe('one')
      expect(next.doc.child(2).textContent).toBe('two')
    })

    it('moves the node down below the next sibling block', () => {
      const state = EditorState.create({ doc: middleDoc() })
      const tr = buildStepMoveTransaction(state, { from: 5, to: 6 }, 'down')

      expect(tr).not.toBeNull()
      const next = state.apply(tr!)
      expect(next.doc.child(0).textContent).toBe('one')
      expect(next.doc.child(1).textContent).toBe('two')
      expect(next.doc.child(2).type.name).toBe('image')
    })

    it('keeps the moved node selected after a step move', () => {
      const state = EditorState.create({ doc: middleDoc() })
      const next = state.apply(buildStepMoveTransaction(state, { from: 5, to: 6 }, 'down')!)

      expect(next.selection).toBeInstanceOf(NodeSelection)
      expect(next.doc.nodeAt(next.selection.from)?.type.name).toBe('image')
    })

    it('cannot move up from the first block', () => {
      const state = EditorState.create({ doc: imageFirstDoc() })

      expect(canStepMove(state, { from: 0, to: 1 }, 'up')).toBe(false)
      expect(buildStepMoveTransaction(state, { from: 0, to: 1 }, 'up')).toBeNull()
      expect(canStepMove(state, { from: 0, to: 1 }, 'down')).toBe(true)
    })

    it('cannot move down from the last block', () => {
      const state = EditorState.create({ doc: imageLastDoc() })

      expect(canStepMove(state, { from: 7, to: 8 }, 'down')).toBe(false)
      expect(buildStepMoveTransaction(state, { from: 7, to: 8 }, 'down')).toBeNull()
      expect(canStepMove(state, { from: 7, to: 8 }, 'up')).toBe(true)
    })
  })
})
