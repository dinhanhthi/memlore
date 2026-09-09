import { Node, mergeAttributes } from '@tiptap/core'

export interface AudioOptions {
  /** Extra HTML attributes sprayed onto the rendered `<audio>` tag. */
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    audio: {
      /** Insert an `<audio>` node with `src` (local or asset URL) and the `data-media-id` that ties it to a `media` DB row. */
      setAudio: (attrs: { src: string; 'data-media-id'?: string | null }) => ReturnType
    }
  }
}

/**
 * Minimal TipTap node for inline audio (voice memo) attachments.
 *
 * Mirrors the `Video` extension exactly but targets `<audio[src]>` elements.
 * The `data-media-id` attribute drives `MediaNodeView` / `MediaAttachment`,
 * which resolves the recording through the shared media pipeline.
 *
 * Playback controls are rendered by `MediaAttachment` (which renders
 * `<audio controls>` when `fileType` starts with `"audio/"`), not by
 * TipTap — the serialised HTML tag has no `controls` attribute so that
 * a stale HTML round-trip cannot expose a different UI.
 */
export const Audio = Node.create<AudioOptions>({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      src: {
        default: null,
      },
      'data-media-id': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-media-id'),
        renderHTML: (attributes) => {
          if (!attributes['data-media-id']) return {}
          return { 'data-media-id': attributes['data-media-id'] }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['audio', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
  },

  addCommands() {
    return {
      setAudio:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    }
  },
})
