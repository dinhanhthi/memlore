import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'
import { deserializeYDoc, snapshotToPmJson } from './yjs'

const FIXTURE = resolve(
  __dirname,
  '../../src-tauri/tests/fixtures/apple-journal/expected/rich-entry.update.bin',
)

const XSS = 'xss-token'

function loadFixture(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE))
}

function walkNodes(node: JSONContent, visit: (n: JSONContent) => void): void {
  visit(node)
  for (const child of node.content ?? []) {
    walkNodes(child, visit)
  }
}

function topLevelTypes(doc: JSONContent): string[] {
  return (doc.content ?? []).map((node) => node.type ?? '')
}

function textWithMark(doc: JSONContent, mark: string): string[] {
  const hits: string[] = []
  walkNodes(doc, (node) => {
    if (node.type !== 'text' || typeof node.text !== 'string') return
    if (node.marks?.some((m) => m.type === mark)) {
      hits.push(node.text)
    }
  })
  return hits
}

function findNode(doc: JSONContent, type: string): JSONContent | undefined {
  let found: JSONContent | undefined
  walkNodes(doc, (node) => {
    if (!found && node.type === type) found = node
  })
  return found
}

describe('Apple Journal Yjs frontend fixture', () => {
  it('decodes marks, nesting, text and media order through snapshotToPmJson', () => {
    const json = snapshotToPmJson(loadFixture())

    expect(json.type).toBe('doc')
    expect(topLevelTypes(json)).toEqual([
      'paragraph',
      'heading',
      'bulletList',
      'image',
      'paragraph',
    ])

    expect(textWithMark(json, 'bold')).toEqual(['bold'])
    expect(textWithMark(json, 'italic')).toEqual(['italic'])
    expect(textWithMark(json, 'underline')).toEqual(['under'])
    expect(textWithMark(json, 'strike')).toEqual(['strike'])
    expect(textWithMark(json, 'highlight')).toEqual(['hi'])
    expect(textWithMark(json, 'link')).toEqual(['link'])

    const heading = findNode(json, 'heading')
    expect(heading?.attrs?.level).toBe(2)
    expect(heading?.content?.some((n) => n.text === 'Second')).toBe(true)

    const list = findNode(json, 'bulletList')
    const nested = list?.content?.[0]?.content?.find((n) => n.type === 'bulletList')
    expect(nested).toBeDefined()
    const nestedText: string[] = []
    if (nested)
      walkNodes(nested, (n) => {
        if (n.type === 'text' && n.text) nestedText.push(n.text)
      })
    expect(nestedText).toContain('child')

    const image = findNode(json, 'image')
    expect(image?.attrs?.['data-media-id']).toBe('media-1')

    const last = json.content?.[json.content.length - 1]
    expect(last?.type).toBe('paragraph')
    expect(last?.content?.some((n) => n.text === 'after')).toBe(true)
  })

  it('keeps a missing-media placeholder through snapshotToPmJson', () => {
    const doc = new Y.Doc()
    const image = new Y.XmlElement('image')
    image.setAttribute('src', '')
    image.setAttribute('data-media-missing', 'true')
    doc.getXmlFragment('default').push([image])

    const json = snapshotToPmJson(Y.encodeStateAsUpdate(doc))
    const missing = findNode(json, 'image')
    expect(missing?.attrs?.['data-media-missing']).toBe('true')
    expect(missing?.attrs?.['data-media-id']).toBeUndefined()
  })

  it('keeps raw HTML in the opaque map and never in rendered editor JSON', () => {
    const bytes = loadFixture()
    const json = snapshotToPmJson(bytes)
    const rendered = JSON.stringify(json)

    expect(rendered).not.toContain(XSS)
    expect(rendered).not.toContain('<script')
    expect(rendered).not.toContain('appleJournalImport')
    expect(rendered).not.toContain('alert(')

    const doc = deserializeYDoc(bytes)
    const provenance = doc.getMap('appleJournalImport').toJSON() as {
      version: number
      rawHtml: string
    }
    expect(provenance.version).toBe(1)
    expect(provenance.rawHtml).toContain(XSS)
    expect(provenance.rawHtml).toContain("<script>alert('xss-token')</script>")
  })

  it('preserves appleJournalImport across a frontend encode/decode/merge edit', () => {
    const bytes = loadFixture()
    const edited = deserializeYDoc(bytes)
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, 'editor-save-token')
    paragraph.insert(0, [text])
    edited.getXmlFragment('default').push([paragraph])

    const merged = new Y.Doc()
    Y.applyUpdate(merged, bytes)
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(edited))

    const provenance = merged.getMap('appleJournalImport').toJSON() as {
      rawHtml: string
      resources: Record<string, { mediaId?: string }>
    }
    expect(provenance.rawHtml).toContain(XSS)
    expect(provenance.resources['photo.jpg']?.mediaId).toBe('media-1')

    const json = snapshotToPmJson(Y.encodeStateAsUpdate(merged))
    const rendered = JSON.stringify(json)
    expect(rendered).toContain('editor-save-token')
    expect(rendered).not.toContain(XSS)
    expect(topLevelTypes(json).at(-1)).toBe('paragraph')
  })
})
