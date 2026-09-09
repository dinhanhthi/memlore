import { describe, expect, it } from 'vitest'
import { isRewriteSnapshotCurrent } from './BubbleMenu'

describe('isRewriteSnapshotCurrent', () => {
  it('allows a rewrite when the document reference is unchanged', () => {
    const requestDoc = { text: 'before selected after' }

    expect(isRewriteSnapshotCurrent(requestDoc, requestDoc)).toBe(true)
  })

  it('rejects a rewrite when a concurrent document transaction preserved the raw selection text', () => {
    const requestDoc = { text: 'before selected after' }
    const concurrentlyChangedDoc = { text: 'before selected after' }

    expect(isRewriteSnapshotCurrent(requestDoc, concurrentlyChangedDoc)).toBe(false)
  })
})
