import { __emit } from '../../web/mocks/event'

const streams = new Map<string, { timer: ReturnType<typeof setInterval>; sessionId: string }>()
export function cancelStream(key: string) {
  const stream = streams.get(key)
  if (!stream) return
  clearInterval(stream.timer)
  streams.delete(key)
  __emit('ai:daily-chat-cancelled', { key })
}
export function cancelSessionStreams(sessionId: string) {
  for (const [key, stream] of streams) if (stream.sessionId === sessionId) cancelStream(key)
}
export function cancelAllStreams() {
  for (const key of streams.keys()) cancelStream(key)
}
export function streamReply(sessionId: string, key: string, content: string, complete: () => void) {
  cancelSessionStreams(sessionId)
  const chunks = content.match(/\S+\s*/g) ?? []
  let index = 0
  const timer = setInterval(() => {
    if (index < chunks.length) __emit('ai:daily-chat-token', { key, delta: chunks[index++] })
    else {
      clearInterval(timer)
      streams.delete(key)
      complete()
      __emit('ai:daily-chat-complete', { key, content, sourceEntryIds: [], memoriesUsed: [] })
    }
  }, 45)
  streams.set(key, { timer, sessionId })
}
