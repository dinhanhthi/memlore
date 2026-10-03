import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { deserializeYDoc } from '../../src/lib/yjs'
import { ENTRY_1_ID, ENTRY_2_ID, ENTRY_3_ID } from './entries'
import { listVersionsForEntry, getVersionContentForEntry, versionEntryById } from './versions'

function paragraphCount(bytes: number[]): number {
  const doc = deserializeYDoc(new Uint8Array(bytes))
  const fragment = doc.getXmlFragment('default')
  return fragment
    .toArray()
    .filter((node) => node instanceof Y.XmlElement && node.nodeName === 'paragraph').length
}

describe('version fixtures', () => {
  it('exposes newest-first history for the latest three entries', () => {
    for (const entryId of [ENTRY_1_ID, ENTRY_2_ID, ENTRY_3_ID]) {
      const versions = listVersionsForEntry(entryId)
      expect(versions.length).toBeGreaterThanOrEqual(3)
      for (let i = 1; i < versions.length; i++) {
        expect(versions[i - 1]!.createdAt).toBeGreaterThanOrEqual(versions[i]!.createdAt)
      }
    }
  })

  it('returns version blobs only when entry id matches', () => {
    const [newest] = listVersionsForEntry(ENTRY_1_ID)
    expect(newest).toBeDefined()
    const bytes = getVersionContentForEntry(newest!.id, ENTRY_1_ID)
    expect(bytes).not.toBeNull()
    expect(paragraphCount(bytes!)).toBeGreaterThan(0)
    expect(getVersionContentForEntry(newest!.id, ENTRY_2_ID)).toBeNull()
  })

  it('maps every version id to its parent entry', () => {
    for (const entryId of [ENTRY_1_ID, ENTRY_2_ID, ENTRY_3_ID]) {
      for (const version of listVersionsForEntry(entryId)) {
        expect(versionEntryById[version.id]).toBe(entryId)
      }
    }
  })
})
