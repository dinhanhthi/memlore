import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  createYDoc,
  serializeYDoc,
  deserializeYDoc,
  extractPlainText,
  yDocContainsMathNodes,
  snapshotToPmJson,
} from './yjs'

describe('createYDoc', () => {
  it('returns a Y.Doc instance', () => {
    const doc = createYDoc('entry-abc')
    expect(doc).toBeInstanceOf(Y.Doc)
  })

  it('creates separate Y.Doc instances for different entry ids', () => {
    const doc1 = createYDoc('entry-1')
    const doc2 = createYDoc('entry-2')
    expect(doc1).not.toBe(doc2)
  })
})

describe('serializeYDoc / deserializeYDoc', () => {
  it('returns a Uint8Array', () => {
    const doc = createYDoc('entry-1')
    const bytes = serializeYDoc(doc)
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it('roundtrip preserves content', () => {
    const doc = createYDoc('entry-1')
    const xmlFragment = doc.getXmlFragment('default')
    // Insert a text node to give the doc some content
    const elem = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, 'Hello roundtrip')
    elem.insert(0, [text])
    xmlFragment.insert(0, [elem])

    const bytes = serializeYDoc(doc)
    const restored = deserializeYDoc(bytes)

    // Serialize again to compare state vectors
    const bytes2 = serializeYDoc(restored)
    expect(bytes2).toBeInstanceOf(Uint8Array)
    // Both docs should encode to the same state
    expect(Y.encodeStateAsUpdate(restored)).toEqual(Y.encodeStateAsUpdate(doc))
  })

  it('deserializes an empty update without error', () => {
    const doc = createYDoc('entry-empty')
    const bytes = serializeYDoc(doc)
    expect(() => deserializeYDoc(bytes)).not.toThrow()
  })
})

describe('yDocContainsMathNodes', () => {
  it('returns false for an empty doc', () => {
    expect(yDocContainsMathNodes(createYDoc('entry-1'))).toBe(false)
  })

  it('returns true when inlineMath is present', () => {
    const doc = createYDoc('entry-1')
    const fragment = doc.getXmlFragment('default')
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlElement('inlineMath')])
    fragment.insert(0, [paragraph])
    expect(yDocContainsMathNodes(doc)).toBe(true)
  })

  it('returns true when blockMath is present', () => {
    const doc = createYDoc('entry-1')
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('blockMath')])
    expect(yDocContainsMathNodes(doc)).toBe(true)
  })
})

describe('snapshotToPmJson', () => {
  it('converts a serialized snapshot back into TipTap JSON content', () => {
    const doc = createYDoc('entry-1')
    const xmlFragment = doc.getXmlFragment('default')
    const elem = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, 'Hello snapshot')
    elem.insert(0, [text])
    xmlFragment.insert(0, [elem])

    const bytes = serializeYDoc(doc)
    const json = snapshotToPmJson(bytes)

    expect(json.type).toBe('doc')
    expect(json.content).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello snapshot' }],
      },
    ])
  })

  it('returns an empty doc for a snapshot with no content', () => {
    const doc = createYDoc('entry-empty')
    const bytes = serializeYDoc(doc)
    const json = snapshotToPmJson(bytes)
    expect(json).toEqual({ type: 'doc', content: [] })
  })
})

describe('extractPlainText', () => {
  it('returns empty string for a fresh doc', () => {
    const doc = createYDoc('entry-1')
    const text = extractPlainText(doc)
    expect(typeof text).toBe('string')
    expect(text).toBe('')
  })

  it('returns plain text from doc content', () => {
    const doc = createYDoc('entry-1')
    const xmlFragment = doc.getXmlFragment('default')
    const elem = new Y.XmlElement('paragraph')
    const yText = new Y.XmlText()
    yText.insert(0, 'Hello world')
    elem.insert(0, [yText])
    xmlFragment.insert(0, [elem])

    const result = extractPlainText(doc)
    expect(result).toContain('Hello world')
  })
})
