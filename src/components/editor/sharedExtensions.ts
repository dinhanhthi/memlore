import { ReactNodeViewRenderer } from '@tiptap/react'
import type { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Image from '@tiptap/extension-image'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import { createLowlight, common } from 'lowlight'
import { MediaNodeView } from './MediaNodeView'
import { Video } from './extensions/Video'
import { Audio } from './extensions/Audio'

export const lowlight = createLowlight(common)

// Extend the built-in Image extension to:
//  1. Preserve the `data-media-id` attribute through HTML serialisation round-trips.
//  2. `data-align` / `data-width` ride in the Yjs XmlFragment (same as data-media-id) and
//     sync to cloud inside the encrypted yjs_doc blob — no separate DB column needed.
//  3. Render via a React NodeView so `MediaAttachment` can lazily resolve the
//     media to a blob URL (or download from cloud) when the editor mounts.
export const ImageWithMediaId = Image.extend({
  // Repositioning is click-driven via ImageBubbleMenu's ↑/↓ buttons
  // (WKWebView never fires HTML5 dragstart inside contenteditable) —
  // disable ProseMirror's native drag so no competing HTML5 drag runs.
  draggable: false,

  addAttributes() {
    return {
      ...this.parent?.(),
      'data-media-id': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-media-id'),
        renderHTML: (attributes) => {
          if (!attributes['data-media-id']) return {}
          return { 'data-media-id': attributes['data-media-id'] }
        },
      },
      ...mediaMissingAttribute(),
      'data-align': {
        default: 'full',
        // Allow-list on parse so pasted/imported HTML can never persist a
        // value outside {left,right,full} (any other value would fall into
        // the right-float branch in MediaNodeView).
        parseHTML: (element) => {
          const a = element.getAttribute('data-align')
          return a === 'left' || a === 'right' ? a : 'full'
        },
        renderHTML: (attributes) => {
          const align = attributes['data-align']
          if (!align || align === 'full') return {}
          return { 'data-align': align }
        },
      },
      'data-width': {
        default: null,
        // Clamp on parse so a crafted `data-width` (negative, zero, or huge)
        // from pasted HTML can't produce a broken/oversized float.
        parseHTML: (element) => {
          const raw = element.getAttribute('data-width')
          if (!raw) return null
          const parsed = parseInt(raw, 10)
          if (!Number.isFinite(parsed)) return null
          return Math.min(100, Math.max(10, parsed))
        },
        renderHTML: (attributes) => {
          const width = attributes['data-width']
          if (!width) return {}
          return { 'data-width': String(width) }
        },
      },
    }
  },

  addNodeView() {
    // `className: 'media-node'` lands on the outer `.react-renderer` element —
    // the one ProseMirror tags with `.ProseMirror-selectednode`. globals.css
    // uses `.ProseMirror-selectednode.media-node` to suppress the generic 2px
    // selection outline (the media toolbar is the selection cue instead).
    return ReactNodeViewRenderer(MediaNodeView, { className: 'media-node' })
  },
})

// Extend the Video node with the same ReactNodeView so `<video data-media-id>`
// nodes render through `MediaAttachment` — which branches on the stored
// `file_type` and mounts a native `<video controls>` player for video MIMEs.
export const VideoWithMediaId = Video.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...mediaMissingAttribute(),
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaNodeView, { className: 'media-node' })
  },
})

// Extend the Audio node with ReactNodeView so `<audio data-media-id>` nodes
// render through `MediaAttachment`, which mounts `<audio controls>` for
// audio/* MIMEs (voice memos, future podcast clips).
export const AudioWithMediaId = Audio.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...mediaMissingAttribute(),
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaNodeView, { className: 'media-node' })
  },
})

function mediaMissingAttribute() {
  return {
    'data-media-missing': {
      default: null as boolean | null,
      parseHTML: (element: HTMLElement) => {
        const raw = element.getAttribute('data-media-missing')
        return raw !== null && raw !== 'false' ? true : null
      },
      renderHTML: (attributes: Record<string, unknown>) => {
        if (!attributes['data-media-missing']) return {}
        return { 'data-media-missing': 'true' }
      },
    },
  }
}

export interface SharedExtensionsOptions {
  /** Pre-loaded math extensions (KaTeX + input rules) — omit when math is off. */
  mathExtensions?: Extension[]
}

/**
 * Content-schema extensions shared between the live collaborative editor
 * (`Editor.tsx`) and the read-only version-history preview
 * (`VersionHistoryModal.tsx`). Deliberately excludes editing-only
 * affordances — `Collaboration` (and therefore undo/redo history),
 * `Placeholder`, `Find`, `EmojiShortcodes`, `SlashMenuExtension`, and
 * `EditorDropIndicator` — those are wired up by each consumer separately
 * (the preview needs none of them since it never accepts edits).
 * `mathExtensions` IS schema-critical (adds the `inlineMath`/`blockMath`
 * node types) and must be included wherever math-containing content might
 * be parsed, so it's a parameter here rather than an editor-only extra.
 */
export function buildSharedExtensions({ mathExtensions = [] }: SharedExtensionsOptions = {}) {
  return [
    StarterKit.configure({
      // Collaboration brings its own undo/redo via Yjs — disable StarterKit's.
      undoRedo: false,
      // Disabled because we add customised replacements below:
      // CodeBlockLowlight replaces the default codeBlock,
      // and we add HorizontalRule, Link, and Underline with custom config.
      codeBlock: false,
      horizontalRule: false,
      link: false,
      underline: false,
      // Replaced by EditorDropIndicator in the live editor — renders inside .ProseMirror.
      dropcursor: false,
    }),
    Underline,
    Highlight,
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    CodeBlockLowlight.configure({ lowlight }),
    ImageWithMediaId,
    VideoWithMediaId,
    AudioWithMediaId,
    HorizontalRule,
    ...mathExtensions,
  ]
}
