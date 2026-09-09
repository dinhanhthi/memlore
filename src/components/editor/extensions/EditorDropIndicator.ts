import { Extension } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import { dropPoint } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

const pluginKey = new PluginKey('editorDropIndicator')

const INDICATOR_HEIGHT_PX = 4
const DRAG_ACTIVE_CLASS = 'prosemirror-block-drag'

export type DragRange = { from: number; to: number }

/** Drag source range from ProseMirror dragging state or the current NodeSelection. */
export function getDragRange(view: EditorView): DragRange | null {
  // ProseMirror types `view.dragging` as `{ slice, move }`, but our drag flow
  // stashes the source node's range on it as `.node`; read it through a widened
  // type instead of asserting the base PM shape so `tsc -b` type-checks it.
  const dragging = view.dragging as { node?: DragRange; slice?: Slice; move?: boolean } | null
  if (dragging?.node) {
    return { from: dragging.node.from, to: dragging.node.to }
  }
  const { selection } = view.state
  if (selection instanceof NodeSelection) {
    return { from: selection.from, to: selection.to }
  }
  return null
}

function dragSourceElement(view: EditorView, range: DragRange): HTMLElement | null {
  const dom = view.nodeDOM(range.from)
  return dom instanceof HTMLElement ? dom : null
}

function withPointerEventsDisabled<T>(el: HTMLElement | null, fn: () => T): T {
  if (!el) return fn()
  const prev = el.style.pointerEvents
  el.style.pointerEvents = 'none'
  try {
    return fn()
  } finally {
    if (prev) el.style.pointerEvents = prev
    else el.style.removeProperty('pointer-events')
  }
}

/** Single-node slice for the node starting at `range.from`, or null. */
function sliceForRange(state: EditorState, range: DragRange): Slice | null {
  const node = state.doc.nodeAt(range.from)
  if (!node || range.from + node.nodeSize !== range.to) return null
  return new Slice(Fragment.from(node), 0, 0)
}

/**
 * Transaction that moves the node covered by `range` so it lands at `target`
 * (snapped to the nearest position where the node fits). Returns null when
 * the drop is a no-op (target inside the source) or the move is impossible.
 */
export function buildMoveTransaction(
  state: EditorState,
  range: DragRange,
  target: number,
): Transaction | null {
  const node = state.doc.nodeAt(range.from)
  const slice = sliceForRange(state, range)
  if (!node || !slice) return null

  const point = dropPoint(state.doc, target, slice)
  if (point == null) return null
  if (point >= range.from && point <= range.to) return null

  const tr = state.tr.delete(range.from, range.to)
  const insertPos = tr.mapping.map(point)
  tr.insert(insertPos, node)
  tr.setSelection(NodeSelection.create(tr.doc, insertPos))
  return tr.scrollIntoView()
}

function resolveDropPos(view: EditorView, clientX: number, clientY: number): number | null {
  const dragRange = getDragRange(view)
  const sourceEl = dragRange ? dragSourceElement(view, dragRange) : null

  // The dragged node stays in the DOM during the drag. Without excluding it
  // from hit-testing, posAtCoords keeps resolving to the source position —
  // especially for floated images that overlap surrounding text.
  const coords = withPointerEventsDisabled(sourceEl, () =>
    view.posAtCoords({ left: clientX, top: clientY }),
  )
  if (!coords) return null

  let target = coords.pos

  // HTML5 drags carry their slice on view.dragging; pointer drags derive it
  // from the dragged node so both paths snap to a valid block boundary.
  const slice = view.dragging?.slice ?? (dragRange ? sliceForRange(view.state, dragRange) : null)
  if (slice) {
    const point = dropPoint(view.state.doc, target, slice)
    if (point != null) target = point
  }
  return target
}

function blockIndicatorRect(view: EditorView, pos: number): DOMRect | null {
  const $pos = view.state.doc.resolve(pos)
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter

  if (!before && !after) return null

  const domPos = pos - (before ? before.nodeSize : 0)
  const node = view.nodeDOM(domPos)
  if (!(node instanceof HTMLElement)) return null

  const nodeRect = node.getBoundingClientRect()
  let top = before ? nodeRect.bottom : nodeRect.top

  if (before && after) {
    const afterNode = view.nodeDOM(pos)
    if (afterNode instanceof HTMLElement) {
      top = (top + afterNode.getBoundingClientRect().top) / 2
    }
  }

  const half = INDICATOR_HEIGHT_PX / 2
  return new DOMRect(nodeRect.left, top - half, nodeRect.width, INDICATOR_HEIGHT_PX)
}

function indicatorRect(view: EditorView, pos: number): DOMRect {
  const $pos = view.state.doc.resolve(pos)
  if (!$pos.parent.inlineContent) {
    const blockRect = blockIndicatorRect(view, pos)
    if (blockRect) return blockRect
  }

  const coords = view.coordsAtPos(pos)
  const half = INDICATOR_HEIGHT_PX / 2
  const editorRect = view.dom.getBoundingClientRect()
  return new DOMRect(editorRect.left, coords.top - half, editorRect.width, INDICATOR_HEIGHT_PX)
}

class EditorDropIndicatorView {
  private readonly view: EditorView
  private readonly el: HTMLDivElement
  private readonly handlers: { name: string; fn: (e: Event) => void }[]

  constructor(view: EditorView) {
    this.view = view
    this.el = document.createElement('div')
    this.el.className = 'editor-drop-indicator'
    this.el.setAttribute('aria-hidden', 'true')
    view.dom.appendChild(this.el)

    const names = ['dragstart', 'dragover', 'dragenter', 'dragleave', 'dragend', 'drop'] as const
    this.handlers = names.map((name) => {
      const fn = (e: Event) => this.onEvent(name, e as DragEvent)
      view.dom.addEventListener(name, fn)
      return { name, fn }
    })
  }

  destroy() {
    for (const { name, fn } of this.handlers) {
      this.view.dom.removeEventListener(name, fn)
    }
    this.el.remove()
    this.view.dom.classList.remove(DRAG_ACTIVE_CLASS)
  }

  private onEvent(
    type: 'dragstart' | 'dragover' | 'dragenter' | 'dragleave' | 'dragend' | 'drop',
    event: DragEvent,
  ) {
    if (type === 'dragstart') {
      this.view.dom.classList.add(DRAG_ACTIVE_CLASS)
      return
    }

    if (type === 'dragend' || type === 'drop') {
      this.view.dom.classList.remove(DRAG_ACTIVE_CLASS)
      this.hide()
      return
    }

    if (type === 'dragleave') {
      const related = event.relatedTarget
      if (!related || !this.view.dom.contains(related as Node)) {
        this.hide()
      }
      return
    }

    if (!this.view.editable) return

    event.preventDefault()

    const pos = resolveDropPos(this.view, event.clientX, event.clientY)
    if (pos == null) {
      this.hide()
      return
    }

    this.showAt(pos)
  }

  private showAt(pos: number) {
    const rect = indicatorRect(this.view, pos)
    const editorRect = this.view.dom.getBoundingClientRect()

    this.el.style.display = 'block'
    this.el.style.top = `${rect.top - editorRect.top + this.view.dom.scrollTop}px`
    this.el.style.left = `${rect.left - editorRect.left + this.view.dom.scrollLeft}px`
    this.el.style.width = `${rect.width}px`
    this.el.style.height = `${rect.height}px`
  }

  private hide() {
    this.el.style.display = 'none'
  }
}

// ── Step move (toolbar ↑/↓) ─────────────────────────────────────────────────
//
// Image repositioning is click-driven from the ImageBubbleMenu: one step
// swaps the node with its previous/next sibling block. (HTML5 drag cannot be
// used — macOS WKWebView never fires `dragstart` inside contenteditable — and
// pointer-drag was dropped in favour of these simpler, discoverable buttons.)

export type StepDirection = 'up' | 'down'

/** Whether the node covered by `range` has a sibling to swap with in `direction`. */
export function canStepMove(
  state: EditorState,
  range: DragRange,
  direction: StepDirection,
): boolean {
  if (!sliceForRange(state, range)) return false
  const $from = state.doc.resolve(range.from)
  const index = $from.index()
  return direction === 'up' ? index > 0 : index < $from.parent.childCount - 1
}

/**
 * Transaction that swaps the node covered by `range` with its previous
 * (`up`) or next (`down`) sibling block. Null at the parent's boundary.
 */
export function buildStepMoveTransaction(
  state: EditorState,
  range: DragRange,
  direction: StepDirection,
): Transaction | null {
  if (!canStepMove(state, range, direction)) return null
  const $from = state.doc.resolve(range.from)
  const index = $from.index()
  const sibling = $from.parent.child(direction === 'up' ? index - 1 : index + 1)
  const target = direction === 'up' ? range.from - sibling.nodeSize : range.to + sibling.nodeSize
  return buildMoveTransaction(state, range, target)
}

/**
 * Visible drop target line rendered inside `.ProseMirror`.
 * Replaces the default StarterKit dropcursor, which appends to
 * `dom.offsetParent` and is easy to miss (1px, wrong stacking context).
 */
export const EditorDropIndicator = Extension.create({
  name: 'editorDropIndicator',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        view(view) {
          return new EditorDropIndicatorView(view)
        },
      }),
    ]
  },
})
