import { Node, mergeAttributes } from '@tiptap/core'

export interface VideoOptions {
  /** Extra HTML attributes sprayed onto the rendered `<video>` tag. */
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    video: {
      /** Insert a `<video>` node with `src` (local or asset URL) and the `data-media-id` that ties it to a `media` DB row. */
      setVideo: (attrs: { src: string; 'data-media-id'?: string | null }) => ReturnType
    }
  }
}

/**
 * Minimal TipTap node for inline video attachments.
 *
 * Mirrors the built-in `Image` extension: a block-level atom that parses
 * `<video src="…" data-media-id="…">` and renders the same shape back out.
 * The `data-media-id` attribute drives `MediaNodeView` / `MediaAttachment`,
 * which resolves the clip through the shared media pipeline (local cache,
 * cloud fetch, encryption) exactly like images.
 *
 * Playback controls are rendered by `MediaAttachment`, not by TipTap — the
 * HTML tag itself is authored as an inert `<video>` element without the
 * `controls` attribute so that a stale HTML round-trip can't accidentally
 * expose a different UI than the live node view.
 */
export const Video = Node.create<VideoOptions>({
  name: 'video',
  group: 'block',
  atom: true,
  // Repositioning is click-driven via VideoBubbleMenu's ↑/↓ buttons — same
  // rationale as ImageWithMediaId: WKWebView never fires HTML5 dragstart inside
  // contenteditable, so native drag is dead weight on macOS.
  draggable: false,

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
      // Float alignment: 'left' | 'right' float the clip; null (default) keeps
      // it centered — so a freshly inserted video lands centered, and the user
      // can opt into a float via VideoBubbleMenu.
      'data-align': {
        default: null,
        // Allow-list on parse so pasted/imported HTML can only ever produce a
        // float direction we handle; anything else falls back to centered.
        parseHTML: (element) => {
          const a = element.getAttribute('data-align')
          return a === 'left' || a === 'right' ? a : null
        },
        renderHTML: (attributes) => {
          const align = attributes['data-align']
          if (align !== 'left' && align !== 'right') return {}
          return { 'data-align': align }
        },
      },
      // Percentage width of the editor column (30 / 50 / 70 / 100). Null =
      // render at the clip's intrinsic size (still centered). Drives the
      // S/M/L/Full presets in VideoBubbleMenu.
      'data-width': {
        default: null,
        // Clamp on parse so a crafted value (negative, zero, huge) from pasted
        // HTML can't produce a broken/oversized layout.
        parseHTML: (element) => {
          const raw = element.getAttribute('data-width')
          if (!raw) return null
          const parsed = parseInt(raw, 10)
          if (!Number.isFinite(parsed)) return null
          return Math.min(100, Math.max(10, parsed))
        },
        renderHTML: (attributes) => {
          if (attributes['data-width'] == null) return {}
          return { 'data-width': String(attributes['data-width']) }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'video[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
  },

  addCommands() {
    return {
      setVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    }
  },
})
