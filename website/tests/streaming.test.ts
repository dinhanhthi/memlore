import { afterEach, expect, it, vi } from 'vitest'
import { listen } from '../../web/mocks/event'
import { cancelAllStreams, cancelSessionStreams, streamReply } from '../demo/streaming'
afterEach(() => {
  cancelAllStreams()
  vi.useRealTimers()
})
it('streams completion with turn identity and cancels isolated sessions', async () => {
  vi.useFakeTimers()
  const done = vi.fn()
  const cancelled = vi.fn()
  const events: unknown[] = []
  const off = await listen('ai:daily-chat-complete', (event) => events.push(event.payload))
  streamReply('one', 'turn-one', 'A quiet moment.', done)
  streamReply('two', 'turn-two', 'Never finish', cancelled)
  cancelSessionStreams('two')
  vi.advanceTimersByTime(1000)
  expect(done).toHaveBeenCalledOnce()
  expect(cancelled).not.toHaveBeenCalled()
  expect(events).toEqual([expect.objectContaining({ key: 'turn-one', content: 'A quiet moment.' })])
  streamReply('three', 'turn-three', 'Reset', cancelled)
  cancelAllStreams()
  expect(vi.getTimerCount()).toBe(0)
  off()
})
