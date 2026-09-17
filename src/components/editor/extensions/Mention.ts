import { Node, mergeAttributes } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mention: {
      /** Insert a mention of another entry: `id` is the entry row id, `label` the title at insert time. */
      insertMention: (attrs: { id: string; label: string }) => ReturnType
    }
  }
}

/**
 * Inline atom that references another entry.
 *
 * Only `{ id, label }` is persisted. `label` is a snapshot of the title at
 * insert time — a fallback for the NodeView (added later), for plaintext /
 * markdown export, and for any context that resolves no live entry. The
 * attribute names are load-bearing: sync code reads `getAttribute('label')`
 * straight off the Yjs element.
 *
 * `draggable: false` for the same reason as Video/ImageWithMediaId — WKWebView
 * never fires HTML5 dragstart inside contenteditable, so native drag is dead
 * weight on macOS.
 *
 * `renderHTML` emits the `@label` text as the node's content so the mention
 * still reads sensibly wherever no NodeView runs (HTML round-trips, clipboard,
 * the version-history preview before its NodeView mounts).
 */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        // Custom parse/render because the defaults would map these onto the
        // bare `id`/`label` HTML attributes — `id` would collide with the
        // document-wide id namespace and `label` isn't valid on a <span>.
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => {
          if (!attributes.id) return {}
          return { 'data-id': attributes.id as string }
        },
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => {
          if (!attributes.label) return {}
          return { 'data-label': attributes.label as string }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'mention' }, HTMLAttributes),
      `@${String(node.attrs.label ?? '')}`,
    ]
  },

  addCommands() {
    return {
      insertMention:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    }
  },
})
