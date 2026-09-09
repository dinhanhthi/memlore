import { describe, it, expect } from 'vitest'
import { resolveEntryButtonState, type EntryButtonInput } from './chatEntryButton'

/**
 * Truth-table coverage for the Daily Chat entry-button resolver
 * (`resolveEntryButtonState`). One assertion per row, including the two
 * streaming variants of each enabled kind (streaming must flip `enabled`
 * without changing `kind`).
 */

function base(over: Partial<EntryButtonInput> = {}): EntryButtonInput {
  return {
    hasNonStreamingAssistant: false,
    isStreaming: false,
    convertedEntryId: null,
    newSinceConversion: false,
    ...over,
  }
}

describe('resolveEntryButtonState', () => {
  it('hides when never converted and there is no assistant reply yet', () => {
    expect(resolveEntryButtonState(base())).toEqual({ kind: 'hidden' })
  })

  it('saves (enabled) when never converted and an assistant reply exists', () => {
    expect(resolveEntryButtonState(base({ hasNonStreamingAssistant: true }))).toEqual({
      kind: 'save',
      enabled: true,
    })
  })

  it('saves but disabled while streaming', () => {
    expect(
      resolveEntryButtonState(base({ hasNonStreamingAssistant: true, isStreaming: true })),
    ).toEqual({ kind: 'save', enabled: false })
  })

  it('updates (enabled) when converted and something arrived after the watermark', () => {
    expect(
      resolveEntryButtonState(
        base({
          hasNonStreamingAssistant: true,
          convertedEntryId: 'e1',
          newSinceConversion: true,
        }),
      ),
    ).toEqual({ kind: 'update', enabled: true })
  })

  it('updates but disabled while streaming', () => {
    expect(
      resolveEntryButtonState(
        base({
          hasNonStreamingAssistant: true,
          isStreaming: true,
          convertedEntryId: 'e1',
          newSinceConversion: true,
        }),
      ),
    ).toEqual({ kind: 'update', enabled: false })
  })

  it('shows update-disabled when converted and nothing is new (not streaming)', () => {
    expect(
      resolveEntryButtonState(
        base({
          hasNonStreamingAssistant: true,
          convertedEntryId: 'e1',
          newSinceConversion: false,
        }),
      ),
    ).toEqual({ kind: 'update-disabled', enabled: false })
  })

  it('update-disabled stays disabled while streaming (kind unchanged)', () => {
    expect(
      resolveEntryButtonState(
        base({
          hasNonStreamingAssistant: true,
          isStreaming: true,
          convertedEntryId: 'e1',
          newSinceConversion: false,
        }),
      ),
    ).toEqual({ kind: 'update-disabled', enabled: false })
  })
})
