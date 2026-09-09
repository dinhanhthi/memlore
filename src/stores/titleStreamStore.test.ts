import { beforeEach, describe, expect, it } from 'vitest'
import { useTitleStreamStore } from './titleStreamStore'

function reset() {
  useTitleStreamStore.setState({ state: { kind: 'idle' } })
}

describe('titleStreamStore', () => {
  beforeEach(reset)

  it('starts in idle', () => {
    expect(useTitleStreamStore.getState().state).toEqual({ kind: 'idle' })
  })

  it('setStreaming transitions to streaming with empty partial', () => {
    useTitleStreamStore.getState().setStreaming('e1', '')
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'streaming',
      entryId: 'e1',
      partial: '',
    })
  })

  it('appendPartial accumulates deltas for matching entry', () => {
    useTitleStreamStore.getState().setStreaming('e1', '')
    useTitleStreamStore.getState().appendPartial('e1', 'Morn')
    useTitleStreamStore.getState().appendPartial('e1', 'ing run')
    const s = useTitleStreamStore.getState().state
    expect(s.kind).toBe('streaming')
    expect(s.kind === 'streaming' && s.partial).toBe('Morning run')
  })

  it('appendPartial ignores deltas for a different entry', () => {
    useTitleStreamStore.getState().setStreaming('e1', 'hello')
    useTitleStreamStore.getState().appendPartial('e2', ' world')
    const s = useTitleStreamStore.getState().state
    expect(s.kind === 'streaming' && s.partial).toBe('hello')
  })

  it('appendPartial ignores deltas when not in streaming state', () => {
    // Direct streaming → done; later token must not resurrect streaming.
    useTitleStreamStore.getState().setStreaming('e1', '')
    useTitleStreamStore.getState().setDone('e1', 'Title')
    useTitleStreamStore.getState().appendPartial('e1', ' extra')
    const s = useTitleStreamStore.getState().state
    expect(s).toEqual({ kind: 'done', entryId: 'e1', title: 'Title' })
  })

  it('setDone transitions to done', () => {
    useTitleStreamStore.getState().setStreaming('e1', 'partial')
    useTitleStreamStore.getState().setDone('e1', 'Final title')
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'done',
      entryId: 'e1',
      title: 'Final title',
    })
  })

  it('setDone ignores completion for a different entry', () => {
    useTitleStreamStore.getState().setStreaming('e1', 'partial')
    useTitleStreamStore.getState().setDone('e2', 'Wrong title')
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'streaming',
      entryId: 'e1',
      partial: 'partial',
    })
  })

  it('setDone is a no-op when not streaming (e.g. after reset)', () => {
    useTitleStreamStore.getState().setDone('e1', 'Title')
    expect(useTitleStreamStore.getState().state).toEqual({ kind: 'idle' })
  })

  it('setError transitions to error', () => {
    useTitleStreamStore.getState().setStreaming('e1', '')
    useTitleStreamStore.getState().setError('e1', 'AI_AUTH_FAILED')
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'error',
      entryId: 'e1',
      code: 'AI_AUTH_FAILED',
    })
  })

  it('setError ignores error for a different entry', () => {
    useTitleStreamStore.getState().setStreaming('e1', 'partial')
    useTitleStreamStore.getState().setError('e2', 'AI_AUTH_FAILED')
    expect(useTitleStreamStore.getState().state).toEqual({
      kind: 'streaming',
      entryId: 'e1',
      partial: 'partial',
    })
  })

  it('reset goes back to idle', () => {
    useTitleStreamStore.getState().setStreaming('e1', 'x')
    useTitleStreamStore.getState().reset()
    expect(useTitleStreamStore.getState().state).toEqual({ kind: 'idle' })
  })
})
