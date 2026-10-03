import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { deserializeYDoc, extractMediaIdsFromYDoc } from '../../src/lib/yjs'
import { entryContent } from './content'
import { ENTRY_1_ID, ENTRY_6_ID, ENTRY_9_ID, ENTRY_11_ID, ENTRY_14_ID } from './entries'
import { MEDIA_1_ID, MEDIA_2_ID, MEDIA_5_ID, MEDIA_14_ID, MEDIA_17_ID } from './media'

function mediaIdsForEntry(entryId: string): Set<string> {
  const bytes = entryContent[entryId]
  expect(bytes).toBeDefined()
  const doc = deserializeYDoc(new Uint8Array(bytes!))
  return extractMediaIdsFromYDoc(doc)
}

describe('entryContent inline images', () => {
  it('embeds the expected media ids in each fixture entry', () => {
    expect(mediaIdsForEntry(ENTRY_1_ID)).toEqual(new Set([MEDIA_5_ID]))
    expect(mediaIdsForEntry(ENTRY_6_ID)).toEqual(new Set([MEDIA_1_ID]))
    expect(mediaIdsForEntry(ENTRY_9_ID)).toEqual(new Set([MEDIA_2_ID]))
    expect(mediaIdsForEntry(ENTRY_11_ID)).toEqual(new Set([MEDIA_14_ID]))
    expect(mediaIdsForEntry(ENTRY_14_ID)).toEqual(new Set([MEDIA_17_ID]))
  })

  it('stores image nodes with data-media-id attributes', () => {
    const doc = deserializeYDoc(new Uint8Array(entryContent[ENTRY_6_ID]!))
    const fragment = doc.getXmlFragment('default')
    const image = fragment
      .toArray()
      .find((node) => node instanceof Y.XmlElement && node.nodeName === 'image')
    expect(image).toBeInstanceOf(Y.XmlElement)
    expect((image as Y.XmlElement).getAttribute('data-media-id')).toBe(MEDIA_1_ID)
    expect((image as Y.XmlElement).getAttribute('data-align')).toBe('left')
    expect((image as Y.XmlElement).getAttribute('data-width')).toBe('45')
  })
})
