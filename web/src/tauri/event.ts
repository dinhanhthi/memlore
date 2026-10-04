export type UnlistenFn = () => void

export interface Event<T> {
  event: string
  id: number
  payload: T
}

type Handler = (e: Event<never>) => void

const listeners = new Map<string, Set<Handler>>()
let nextId = 1

export async function listen<T>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set<Handler>()
  const entry = handler as unknown as Handler
  set.add(entry)
  listeners.set(event, set)
  return () => {
    set.delete(entry)
    if (set.size === 0 && listeners.get(event) === set) listeners.delete(event)
  }
}

export async function once<T>(event: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (e) => {
    unlisten()
    handler(e)
  })
  return unlisten
}

/** Same as the real `emit`: delivers to listeners in this page. */
export async function emit(event: string, payload?: unknown): Promise<void> {
  emitFromBackend(event, payload)
}

/** Internal: the web backend pushes events to `listen`ers through this. */
export function emitFromBackend(event: string, payload?: unknown): void {
  const set = listeners.get(event)
  if (!set) return
  const id = nextId++
  for (const handler of [...set]) {
    try {
      handler({ event, id, payload } as Event<never>)
    } catch (err) {
      console.error('[web event] listener threw for', event, err)
    }
  }
}
