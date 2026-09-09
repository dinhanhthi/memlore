import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { JSONContent } from '@tiptap/core'

/**
 * Create a fresh Y.Doc for the given entry id.
 * Each entry has its own document bound to the 'default' XmlFragment,
 * which TipTap's Collaboration extension uses.
 */
export function createYDoc(_entryId: string): Y.Doc {
  return new Y.Doc()
}

/**
 * Serialize a Y.Doc to a Uint8Array using Yjs state encoding.
 * This is what gets stored in the `yjs_doc` BLOB column.
 */
export function serializeYDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc)
}

/**
 * Deserialize a Uint8Array back into a Y.Doc.
 * Creates a fresh doc and applies the stored update to it.
 */
export function deserializeYDoc(data: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, data)
  return doc
}

/**
 * Convert a stored version snapshot (raw Yjs state bytes) into TipTap-
 * compatible JSON content for `editor.commands.setContent` and read-only
 * previews. `@tiptap/y-tiptap` is TipTap 3's maintained fork of
 * `y-prosemirror` — already a direct dependency (see package.json) — and
 * exposes the same `yDocToProsemirrorJSON` helper.
 *
 * `yDocToProsemirrorJSON` is `@deprecated` upstream in favor of
 * `yXmlFragmentToProseMirrorRootNode`, but that replacement needs a live
 * ProseMirror `Schema` and returns a `Node` rather than plain JSON — it
 * would couple this pure, schema-free utility to a specific editor
 * instance and break the plain-JSON contract `setContent`'s `Content`
 * type already accepts. `yDocToProsemirrorJSON` still works correctly
 * and is not scheduled for removal; kept intentionally.
 */
export function snapshotToPmJson(bytes: Uint8Array): JSONContent {
  const doc = deserializeYDoc(bytes)
  return yDocToProsemirrorJSON(doc, 'default') as JSONContent
}

/**
 * Extract plain text content from a Y.Doc's XmlFragment.
 * Walks the fragment tree and concatenates all text nodes.
 * Used to keep the FTS5 `content_text` index up to date.
 */
export function extractPlainText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment('default')
  return xmlFragmentToText(fragment).trim()
}

function xmlFragmentToText(fragment: Y.XmlFragment): string {
  let result = ''
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i)
    if (child instanceof Y.XmlText) {
      result += child.toString()
    } else if (child instanceof Y.XmlElement) {
      result += xmlElementToText(child)
    }
  }
  return result
}

const BLOCK_TAGS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'taskList',
  'tableRow',
  'tableCell',
  'tableHeader',
  'horizontalRule',
])

function xmlElementToText(elem: Y.XmlElement): string {
  let result = ''
  for (let i = 0; i < elem.length; i++) {
    const child = elem.get(i)
    if (child instanceof Y.XmlText) {
      result += child.toString()
    } else if (child instanceof Y.XmlElement) {
      result += xmlElementToText(child)
    }
  }
  const tag = elem.nodeName?.toLowerCase() ?? ''
  return BLOCK_TAGS.has(tag) ? result + '\n' : result
}

/**
 * Collect all `data-media-id` values from a Y.Doc's XmlFragment.
 * Used to detect media rows that exist in the DB but are absent from the
 * Yjs doc (e.g. inserted during the auto-save bug window).
 */
export function extractMediaIdsFromYDoc(doc: Y.Doc): Set<string> {
  const ids = new Set<string>()
  collectXmlMediaIds(doc.getXmlFragment('default'), ids)
  return ids
}

function collectXmlMediaIds(node: Y.XmlFragment | Y.XmlElement, ids: Set<string>): void {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i)
    if (child instanceof Y.XmlElement) {
      const mediaId = child.getAttribute('data-media-id')
      if (typeof mediaId === 'string' && mediaId) ids.add(mediaId)
      collectXmlMediaIds(child, ids)
    }
  }
}

const MATH_NODE_NAMES = new Set(['inlinemath', 'blockmath'])

function xmlTreeContainsMath(node: Y.XmlFragment | Y.XmlElement): boolean {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i)
    if (child instanceof Y.XmlElement) {
      const tag = child.nodeName?.toLowerCase() ?? ''
      if (MATH_NODE_NAMES.has(tag)) return true
      if (xmlTreeContainsMath(child)) return true
    }
  }
  return false
}

/**
 * True when the Y.Doc's ProseMirror fragment already contains math nodes.
 * Used to force-load the math schema even when the setting is off — binding
 * Yjs without those node types permanently strips math from the document.
 */
export function yDocContainsMathNodes(doc: Y.Doc): boolean {
  return xmlTreeContainsMath(doc.getXmlFragment('default'))
}
